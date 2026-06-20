import { readdirSync } from "node:fs";
import os from "node:os";

import gateway from "../gateway.ts";
import { json } from "../http.ts";
import { runProcess } from "../lib/processes.ts";
import { stringFallback } from "../lib/values.ts";

interface CpuMetrics {
    count: number;
    loadAvg: number[];
    loadPercent: number;
    model: string;
}

interface MemoryMetrics {
    free: number;
    percent: number;
    total: number;
    totalGB: number;
    used: number;
    usedGB: number;
}

interface DiskMetrics {
    percent: number;
    total: number;
    totalGB: number;
    used: number;
    usedGB: number;
}

interface SystemMetrics {
    hostname: string;
    platform: string;
    uptime: number;
}

interface NetworkMetrics {
    downloadMbps: number;
    uploadMbps: number;
}

interface SystemMetricsResponse {
    cpu: CpuMetrics;
    disk: DiskMetrics;
    memory: MemoryMetrics;
    network: NetworkMetrics;
    system: SystemMetrics;
    timestamp: number;
}

interface TokenMetrics {
    byAgent: Array<{
        label: string;
        model: string;
        tokens: number;
        type: string;
    }>;
    byModel: Record<string, number>;
    sessionsByModel: Record<string, number>;
    total: number;
}

interface MetricsResponse extends SystemMetricsResponse {
    tokens: TokenMetrics;
}

const metricsRouteState: {
    previousNetworkSample: null | {
        downloadBytes: number;
        timestamp: number;
        uploadBytes: number;
    };
} = { previousNetworkSample: null };

async function getNetworkMetrics(): Promise<NetworkMetrics> {
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
            const rxText = await Bun.file(`${basePath}/rx_bytes`).text();
            const txText = await Bun.file(`${basePath}/tx_bytes`).text();
            const rxBytes = Number(rxText.trim());
            const txBytes = Number(txText.trim());

            if (!Number.isNaN(rxBytes)) downloadBytes += rxBytes;
            if (!Number.isNaN(txBytes)) uploadBytes += txBytes;
        }
    } catch (error) {
        console.error("[Metrics] network error:", (error as Error).message);
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
    metricsRouteState.previousNetworkSample = { downloadBytes, timestamp, uploadBytes };

    return {
        downloadMbps:
            Math.round(((downloadDelta * 8) / 1_000_000 / elapsedSeconds) * 100) / 100,
        uploadMbps:
            Math.round(((uploadDelta * 8) / 1_000_000 / elapsedSeconds) * 100) / 100,
    };
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
        const { stdout } = await runProcess("df", [
            "-B1",
            "--output=size,used,pcent",
            "/",
        ]);
        const parts = (stdout.trim().split("\n").at(-1) ?? "").trim().split(/\s+/u);
        if (parts.length >= 3) {
            diskTotal = Number(parts[0]);
            diskUsed = Number(parts[1]);
            diskPercent = Number(parts[2].replace(/%$/u, ""));
        }
    } catch (error) {
        console.error("[Metrics] df error:", (error as Error).message);
    }

    return {
        cpu: {
            count: cpus.length,
            loadAvg: loadAvg.map((value) => Math.round(value * 100) / 100),
            loadPercent: Math.round((loadAvg[0] / cpus.length) * 100),
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
    const byModel: Record<string, number> = {};
    const sessionsByModel: Record<string, number> = {};
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
        byAgent: byAgent.sort((a, b) => b.tokens - a.tokens).slice(0, 10),
        byModel,
        sessionsByModel,
        total: totalTokens,
    };
}

export const metricsRoutes = {
    "/api/metrics": {
        GET: async () => {
            try {
                return json({
                    ...(await getSystemMetrics()),
                    tokens: getTokenMetrics(),
                } satisfies MetricsResponse);
            } catch (error) {
                return json({ error: (error as Error).message }, { status: 500 });
            }
        },
    },
} as const;
