import { execSync } from "child_process";
import express, { type RequestHandler } from "express";
import { readdirSync, readFileSync } from "fs";
import os from "os";

import gateway from "../gateway.js";

/** Describes cpu metrics. */
interface CpuMetrics {
    count: number;
    model: string;
    loadAvg: number[];
    loadPercent: number;
}

/** Describes memory metrics. */
interface MemoryMetrics {
    total: number;
    used: number;
    free: number;
    percent: number;
    totalGB: number;
    usedGB: number;
}

/** Describes disk metrics. */
interface DiskMetrics {
    total: number;
    used: number;
    percent: number;
    totalGB: number;
    usedGB: number;
}

/** Describes system metrics. */
interface SystemMetrics {
    uptime: number;
    platform: string;
    hostname: string;
}

/** Describes network metrics. */
interface NetworkMetrics {
    downloadMbps: number;
    uploadMbps: number;
}

/** Describes system metrics response. */
interface SystemMetricsResponse {
    cpu: CpuMetrics;
    memory: MemoryMetrics;
    disk: DiskMetrics;
    system: SystemMetrics;
    network: NetworkMetrics;
    timestamp: number;
}

/** Describes token metrics. */
interface TokenMetrics {
    total: number;
    byModel: Record<string, number>;
    sessionsByModel: Record<string, number>;
    byAgent: Array<{
        label: string;
        model: string;
        tokens: number;
        type: string;
    }>;
}

/** Describes metrics response. */
interface MetricsResponse extends SystemMetricsResponse {
    tokens: TokenMetrics;
}

let previousNetworkSample: {
    timestamp: number;
    downloadBytes: number;
    uploadBytes: number;
} | null = null;

/** Handles get network metrics. */
function getNetworkMetrics(): NetworkMetrics {
    let downloadBytes = 0;
    let uploadBytes = 0;

    try {
        const preferredInterface = "enp0s6";
        const availableInterfaces = readdirSync("/sys/class/net");
        const interfaces = availableInterfaces.includes(preferredInterface)
            ? [preferredInterface]
            : availableInterfaces.filter((name) => name !== "lo");

        for (const name of interfaces) {
            const basePath = `/sys/class/net/${name}/statistics`;
            const rxBytes = Number.parseInt(
                readFileSync(`${basePath}/rx_bytes`, "utf8").trim(),
                10
            );
            const txBytes = Number.parseInt(
                readFileSync(`${basePath}/tx_bytes`, "utf8").trim(),
                10
            );

            if (!Number.isNaN(rxBytes)) {
                downloadBytes += rxBytes;
            }

            if (!Number.isNaN(txBytes)) {
                uploadBytes += txBytes;
            }
        }
    } catch (error) {
        console.error("[Metrics] network error:", (error as Error).message);
    }

    const timestamp = Date.now();

    if (!previousNetworkSample) {
        previousNetworkSample = { timestamp, downloadBytes, uploadBytes };
        return {
            downloadMbps: 0,
            uploadMbps: 0,
        };
    }

    const elapsedSeconds = (timestamp - previousNetworkSample.timestamp) / 1000;

    if (elapsedSeconds <= 0) {
        return {
            downloadMbps: 0,
            uploadMbps: 0,
        };
    }

    const downloadDelta = Math.max(
        0,
        downloadBytes - previousNetworkSample.downloadBytes
    );
    const uploadDelta = Math.max(0, uploadBytes - previousNetworkSample.uploadBytes);

    previousNetworkSample = { timestamp, downloadBytes, uploadBytes };

    return {
        downloadMbps:
            Math.round(((downloadDelta * 8) / 1_000_000 / elapsedSeconds) * 100) / 100,
        uploadMbps:
            Math.round(((uploadDelta * 8) / 1_000_000 / elapsedSeconds) * 100) / 100,
    };
}

/** Handles get system metrics. */
function getSystemMetrics(): SystemMetricsResponse {
    // CPU
    const cpus = os.cpus();
    const loadAvg = os.loadavg();

    // Memory
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const memPercent = Math.round((usedMem / totalMem) * 100);

    // Disk
    let diskTotal = 0;
    let diskUsed = 0;
    let diskPercent = 0;

    try {
        const dfOutput = execSync("df -B1 / | tail -1", { encoding: "utf8" });
        const parts = dfOutput.trim().split(/\s+/);
        if (parts.length >= 4) {
            diskTotal = Number.parseInt(parts[1], 10);
            diskUsed = Number.parseInt(parts[2], 10);
            diskPercent = Number.parseInt(parts[4], 10);
        }
    } catch (error) {
        console.error("[Metrics] df error:", (error as Error).message);
    }

    // Uptime
    const uptime = os.uptime();
    const network = getNetworkMetrics();

    return {
        cpu: {
            count: cpus.length,
            model: cpus[0]?.model || "Unknown",
            loadAvg: loadAvg.map((v) => Math.round(v * 100) / 100),
            loadPercent: Math.round((loadAvg[0] / cpus.length) * 100),
        },
        memory: {
            total: totalMem,
            used: usedMem,
            free: freeMem,
            percent: memPercent,
            totalGB: Math.round((totalMem / 1024 / 1024 / 1024) * 10) / 10,
            usedGB: Math.round((usedMem / 1024 / 1024 / 1024) * 10) / 10,
        },
        disk: {
            total: diskTotal,
            used: diskUsed,
            percent: diskPercent,
            totalGB: Math.round((diskTotal / 1024 / 1024 / 1024) * 10) / 10,
            usedGB: Math.round((diskUsed / 1024 / 1024 / 1024) * 10) / 10,
        },
        system: {
            uptime,
            platform: os.platform(),
            hostname: os.hostname(),
        },
        network,
        timestamp: Date.now(),
    };
}

/** Handles get token metrics. */
function getTokenMetrics(): TokenMetrics {
    const sessions = gateway.getSessions();
    let totalTokens = 0;
    const byModel: Record<string, number> = {};
    const sessionsByModel: Record<string, number> = {};
    const byAgent: Array<{ label: string; model: string; tokens: number; type: string }> =
        [];

    for (const session of sessions) {
        const model = session.model || "unknown";
        const tokens = session.tokenCount || 0;

        totalTokens += tokens;
        byModel[model] = (byModel[model] || 0) + tokens;

        // Count sessions by model
        const modelKey = model.split("/").pop() || model; // Remove provider prefix
        sessionsByModel[modelKey] = (sessionsByModel[modelKey] || 0) + 1;

        // Agent data
        if (session.displayLabel || session.label) {
            byAgent.push({
                label: session.displayLabel || session.label || "Unknown",
                model: model,
                tokens: tokens,
                type: session.type || "Unknown",
            });
        }
    }

    return {
        total: totalTokens,
        byModel,
        sessionsByModel,
        byAgent: byAgent.sort((a, b) => b.tokens - a.tokens).slice(0, 10),
    };
}

/** Handles metrics routes. */
export default function metricsRoutes(app: express.Application): void {
    app.get("/api/metrics", (async (_req, res) => {
        try {
            const system = getSystemMetrics();
            const tokens = getTokenMetrics();

            res.json({
                ...system,
                tokens,
            } satisfies MetricsResponse);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
