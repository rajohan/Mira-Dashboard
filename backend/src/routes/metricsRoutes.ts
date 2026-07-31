import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Metrics } from "../../../contracts/metrics.ts";
import gateway from "../gateway.ts";
import { json } from "../http.ts";
import {
    CoalescedSnapshot,
    getCoalescedSnapshotMetrics,
} from "../lib/coalescedSnapshot.ts";
import { getHttpRequestMetrics } from "../lib/httpRequestMetrics.ts";
import { runProcess } from "../lib/processes.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { stringFallback } from "../lib/values.ts";
import { getAppObservabilityMetrics } from "../observability.ts";
import { routeErrorResponse } from "../routeSupport.ts";

interface NetworkMetrics {
    downloadMbps: number;
    uploadMbps: number;
}

type SystemMetricsResponse = Pick<
    Metrics,
    "cpu" | "disk" | "memory" | "network" | "system" | "timestamp"
>;
type TokenMetrics = Metrics["tokens"];

const PREFERRED_LINUX_NETWORK_INTERFACE = "enp0s6";
const METRICS_FRESH_MS = 2000;
const METRICS_STALE_MS = 10_000;
const logger = createStructuredLogger("metrics");

const metricsRouteState: {
    networkSampleLock: Promise<void>;
    previousNetworkSample:
        | undefined
        | {
              downloadBytes: number;
              timestamp: number;
              uploadBytes: number;
          };
} = { networkSampleLock: Promise.resolve(), previousNetworkSample: undefined };

async function withNetworkSampleLock<T>(callback: () => Promise<T> | T): Promise<T> {
    const previousLock = metricsRouteState.networkSampleLock;
    const lock = Promise.withResolvers<void>();
    metricsRouteState.networkSampleLock = lock.promise;
    await previousLock;
    try {
        return await callback();
    } finally {
        lock.resolve();
    }
}

function finiteNumber(value: unknown): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

async function getNetworkMetrics(): Promise<NetworkMetrics> {
    return withNetworkSampleLock(async () => {
        let downloadBytes = 0;
        let uploadBytes = 0;
        let didReadNetwork = false;

        if (os.platform() === "linux") {
            try {
                // Prefer the VPS default Linux interface, then fall back to every
                // non-loopback interface when it is unavailable.
                const availableInterfaces = await readdir("/sys/class/net");
                const interfaces = availableInterfaces.includes(
                    PREFERRED_LINUX_NETWORK_INTERFACE
                )
                    ? [PREFERRED_LINUX_NETWORK_INTERFACE]
                    : availableInterfaces.filter((name) => name !== "lo");

                for (const name of interfaces) {
                    const basePath = `/sys/class/net/${name}/statistics`;
                    const rxText = await Bun.file(`${basePath}/rx_bytes`).text();
                    const txText = await Bun.file(`${basePath}/tx_bytes`).text();
                    const rxBytes = Number(rxText.trim());
                    const txBytes = Number(txText.trim());

                    if (!Number.isNaN(rxBytes)) downloadBytes += rxBytes;
                    if (!Number.isNaN(txBytes)) uploadBytes += txBytes;
                }
                didReadNetwork = true;
            } catch (sysError) {
                try {
                    const networkDeviceText = await Bun.file("/proc/net/dev").text();
                    const rows = networkDeviceText.split("\n").flatMap((line) => {
                        const separator = line.indexOf(":");
                        if (separator === -1) return [];
                        const name = line.slice(0, separator).trim();
                        const fields = line
                            .slice(separator + 1)
                            .trim()
                            .split(/\s+/u);
                        const rxBytes = Number(fields[0]);
                        const txBytes = Number(fields[8]);
                        return name &&
                            Number.isFinite(rxBytes) &&
                            Number.isFinite(txBytes)
                            ? [{ name, rxBytes, txBytes }]
                            : [];
                    });
                    const nonLoopbackRows = rows.filter((row) => row.name !== "lo");
                    const selectedRows = nonLoopbackRows.some(
                        (row) => row.name === PREFERRED_LINUX_NETWORK_INTERFACE
                    )
                        ? nonLoopbackRows.filter(
                              (row) => row.name === PREFERRED_LINUX_NETWORK_INTERFACE
                          )
                        : nonLoopbackRows;
                    for (const row of selectedRows) {
                        downloadBytes += row.rxBytes;
                        uploadBytes += row.txBytes;
                    }
                    didReadNetwork = selectedRows.length > 0;
                } catch (procError) {
                    logger.error("metrics.network_read_failed", {
                        procError,
                        sysError,
                    });
                }
            }
        } else {
            // Network byte counters are currently supported through Linux /sys only.
        }

        if (!didReadNetwork) {
            return { downloadMbps: 0, uploadMbps: 0 };
        }
        const timestamp = Date.now();
        if (!metricsRouteState.previousNetworkSample) {
            metricsRouteState.previousNetworkSample = {
                downloadBytes,
                timestamp,
                uploadBytes,
            };
            return { downloadMbps: 0, uploadMbps: 0 };
        }

        const elapsedSeconds =
            (timestamp - metricsRouteState.previousNetworkSample.timestamp) / 1000;
        if (elapsedSeconds <= 0) {
            metricsRouteState.previousNetworkSample = {
                downloadBytes,
                timestamp,
                uploadBytes,
            };
            return { downloadMbps: 0, uploadMbps: 0 };
        }

        const downloadDelta = Math.max(
            0,
            downloadBytes - metricsRouteState.previousNetworkSample.downloadBytes
        );
        const uploadDelta = Math.max(
            0,
            uploadBytes - metricsRouteState.previousNetworkSample.uploadBytes
        );
        metricsRouteState.previousNetworkSample = {
            downloadBytes,
            timestamp,
            uploadBytes,
        };

        return {
            downloadMbps:
                Math.round(((downloadDelta * 8) / 1_000_000 / elapsedSeconds) * 100) /
                100,
            uploadMbps:
                Math.round(((uploadDelta * 8) / 1_000_000 / elapsedSeconds) * 100) / 100,
        };
    });
}

async function getSystemMetrics(): Promise<SystemMetricsResponse> {
    const cpus = os.cpus();
    const loadAvg = os.loadavg();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    let diskTotal = 0;
    let diskUsed = 0;
    let diskPercent = 0;

    try {
        const isDarwin = os.platform() === "darwin";
        const diskPath = path.resolve(process.cwd());
        const dfArguments = isDarwin
            ? ["-k", diskPath]
            : ["-B1", "--output=size,used,pcent", diskPath];
        const { code, stderr, stdout } = await runProcess("df", dfArguments, {
            timeoutMs: 5000,
        });
        if (code !== 0) throw new Error(stderr || `df exited ${code}`);
        const parts = (stdout.trim().split("\n").at(-1) ?? "").trim().split(/\s+/u);
        if (isDarwin && parts.length >= 5) {
            diskTotal = finiteNumber(parts[1]) * 1024;
            diskUsed = finiteNumber(parts[2]) * 1024;
            diskPercent = finiteNumber((parts[4] ?? "0").replace(/%$/u, ""));
        } else if (!isDarwin && parts.length >= 3) {
            diskTotal = finiteNumber(parts[0]);
            diskUsed = finiteNumber(parts[1]);
            diskPercent = finiteNumber((parts[2] ?? "0").replace(/%$/u, ""));
        }
    } catch (error) {
        logger.error("metrics.disk_read_failed", { error });
    }

    return {
        cpu: {
            count: cpus.length,
            loadAvg: loadAvg.map((value) => Math.round(value * 100) / 100),
            loadPercent:
                cpus.length > 0 ? Math.round(((loadAvg[0] ?? 0) / cpus.length) * 100) : 0,
            model: stringFallback(cpus[0]?.model, "Unknown"),
        },
        disk: {
            percent: diskPercent,
            total: diskTotal,
            totalGB: Math.round((diskTotal / 1024 / 1024 / 1024) * 10) / 10,
            used: diskUsed,
            usedGB: Math.round((diskUsed / 1024 / 1024 / 1024) * 10) / 10,
        },
        memory: {
            free: freeMem,
            percent: memPercent,
            total: totalMem,
            totalGB: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
            used: usedMem,
            usedGB: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
        },
        network: await getNetworkMetrics(),
        system: {
            hostname: os.hostname(),
            platform: os.platform(),
            uptime: os.uptime(),
        },
        timestamp: Date.now(),
    };
}

function getTokenMetrics(): TokenMetrics {
    const sessions = gateway.getSessions();
    let totalTokens = 0;
    const byModel = Object.create(null) as Record<string, number>;
    const sessionsByModel = Object.create(null) as Record<string, number>;
    const byAgent: Array<{ label: string; model: string; tokens: number; type: string }> =
        [];

    for (const session of sessions) {
        const model = stringFallback(session.model).trim() || "unknown";
        const tokens = session.tokenCount || 0;
        totalTokens += tokens;
        byModel[model] = (byModel[model] || 0) + tokens;

        const parsedModelKey = model.includes("/")
            ? stringFallback(model.split("/").pop()).trim()
            : model;
        const modelKey = parsedModelKey || model;
        sessionsByModel[modelKey] = (sessionsByModel[modelKey] || 0) + 1;

        const displayLabel = stringFallback(session.displayLabel).trim();
        const fallbackLabel = stringFallback(session.label).trim();
        const sessionType = stringFallback(session.type).trim() || "Unknown";
        const agentLabel = displayLabel || fallbackLabel;
        if (agentLabel) {
            byAgent.push({ label: agentLabel, model, tokens, type: sessionType });
        }
    }

    return {
        byAgent: byAgent.toSorted((a, b) => b.tokens - a.tokens).slice(0, 10),
        byModel,
        sessionsByModel,
        total: totalTokens,
    };
}

const metricsSnapshot = new CoalescedSnapshot<Metrics>({
    freshForMs: METRICS_FRESH_MS,
    load: async () => {
        const [system, observability] = await Promise.all([
            getSystemMetrics(),
            getAppObservabilityMetrics(),
        ]);
        return {
            ...system,
            ...observability,
            http: getHttpRequestMetrics(),
            polling: {
                snapshots: getCoalescedSnapshotMetrics(),
            },
            tokens: getTokenMetrics(),
        };
    },
    name: "system.metrics",
    staleForMs: METRICS_STALE_MS,
});

export const metricsRoutes = {
    "/api/metrics": {
        GET: async (request = new Request("http://localhost/api/metrics")) => {
            try {
                return json(await metricsSnapshot.read());
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "metrics_snapshot_failed",
                    context: "metrics.snapshot",
                    message: "Failed to fetch metrics",
                });
            }
        },
    },
} as const;
