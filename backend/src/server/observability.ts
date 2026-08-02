import fs from "node:fs";

import type {
    AppObservabilityMetrics,
    DatabaseMetrics,
} from "../../../contracts/metrics.ts";
import { database, getMiraDatabasePath } from "../database/connection.ts";
import { getDatabaseOperationMetrics } from "../lib/databaseMetrics.ts";
import { getChildProcessMetrics } from "../lib/processes.ts";
import { getRuntimeMetrics } from "../lib/runtimeMetrics.ts";
import { getCacheRefreshMetrics } from "../services/cacheRefreshMetrics.ts";
import gateway from "../services/gateway/runtime.ts";
import { getScheduledJobSchedulerMetrics } from "../services/scheduledJobs/runtime.ts";

function fileBytes(path: string): number {
    try {
        return fs.statSync(path).size;
    } catch (error) {
        void error;
        return 0;
    }
}

function pragmaNumber(name: "freelist_count" | "page_count" | "page_size"): number {
    const row = database.query(`PRAGMA ${name}`).get() as Record<string, number>;
    return Number(row[name] ?? 0);
}

/**
 * Samples SQLite health and storage without exposing SQL text or database paths.
 * @returns Database metrics value.
 */
export function getDatabaseMetrics(): DatabaseMetrics {
    const databasePath = getMiraDatabasePath();
    let isAvailable = false;
    let latencyMs: number;
    let pageCount = 0;
    let pageSize = 0;
    let freelistPages = 0;
    const startedAt = performance.now();
    try {
        database.query("SELECT 1").get();
        latencyMs = Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
        pageCount = pragmaNumber("page_count");
        pageSize = pragmaNumber("page_size");
        freelistPages = pragmaNumber("freelist_count");
        isAvailable = true;
    } catch {
        latencyMs = Math.round(Math.max(0, performance.now() - startedAt) * 100) / 100;
    }
    const operationMetrics = getDatabaseOperationMetrics();
    const freelistBytes = freelistPages * pageSize;
    return {
        ...operationMetrics,
        available: isAvailable,
        fileBytes: fileBytes(databasePath),
        freelistBytes,
        freelistPages,
        freelistPercent:
            pageCount === 0 ? 0 : Math.round((freelistPages / pageCount) * 10_000) / 100,
        latencyMs,
        shmBytes: fileBytes(`${databasePath}-shm`),
        walBytes: fileBytes(`${databasePath}-wal`),
    };
}

/**
 * Collects the authenticated application-level observability snapshot.
 * @returns App observability metrics value.
 */
export async function getAppObservabilityMetrics(): Promise<AppObservabilityMetrics> {
    const runtime = getRuntimeMetrics();
    return {
        cacheRefresh: getCacheRefreshMetrics(),
        chat: gateway.getChatMetrics(),
        database: getDatabaseMetrics(),
        gateway: gateway.getMetrics(),
        processes: getChildProcessMetrics(),
        runtime: await runtime,
        scheduler: getScheduledJobSchedulerMetrics(),
    };
}
