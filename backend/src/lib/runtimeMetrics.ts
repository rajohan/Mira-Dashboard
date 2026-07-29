import type { RuntimeMetrics } from "../../../contracts/metrics.ts";

/**
 * Samples process memory and one zero-delay event-loop turn.
 * @returns Runtime metrics value.
 */
export async function getRuntimeMetrics(): Promise<RuntimeMetrics> {
    const startedAt = performance.now();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const memory = process.memoryUsage();
    return {
        eventLoopDelayMs: Math.round((performance.now() - startedAt) * 100) / 100,
        externalBytes: memory.external,
        heapTotalBytes: memory.heapTotal,
        heapUsedBytes: memory.heapUsed,
        rssBytes: memory.rss,
        uptimeSeconds: process.uptime(),
    };
}
