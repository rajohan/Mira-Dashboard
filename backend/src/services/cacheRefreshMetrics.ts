import fs from "node:fs";
import path from "node:path";

import * as v from "valibot";

import type { CacheRefreshMetrics } from "../../../contracts/metrics.ts";
import { cacheRefreshMetricsSchema } from "../../../contracts/metrics.ts";

const CACHE_REFRESH_METRICS_SNAPSHOT_VERSION = 1;
const MAX_CACHE_REFRESH_METRICS_SNAPSHOT_BYTES = 16 * 1024;
const RUNTIME_DIRECTORY_NAME = "mira-dashboard";
const SNAPSHOT_FILE_NAME = "cache-refresh-metrics.json";

interface CacheRefreshMetricsSnapshot {
    instanceId: string;
    metrics: CacheRefreshMetrics;
    pid: number;
    startedAt: string;
    version: typeof CACHE_REFRESH_METRICS_SNAPSHOT_VERSION;
}

interface CacheRefreshMetricsSessionOptions {
    environment?: Record<string, string | undefined>;
    snapshotPath?: string;
}

const emptyCacheRefreshMetrics = (): CacheRefreshMetrics => ({
    active: 0,
    averageDurationMs: 0,
    coalesced: 0,
    failures: 0,
    lastDurationMs: 0,
    maxDurationMs: 0,
    refreshes: 0,
    requests: 0,
    totalDurationMs: 0,
});

let cacheRefreshMetricsState = emptyCacheRefreshMetrics();
let activeSession:
    | {
          instanceId: string;
          snapshotPath: string | undefined;
          startedAt: string;
      }
    | undefined;

function runtimeDirectory(
    environment: Record<string, string | undefined>
): string | undefined {
    const configured = environment.XDG_RUNTIME_DIR?.trim();
    if (configured) {
        return path.isAbsolute(configured) ? path.resolve(configured) : undefined;
    }
    if (environment.NODE_ENV === "production" && typeof process.getuid === "function") {
        return `/run/user/${process.getuid()}`;
    }
    return undefined;
}

/**
 * Resolves the private, reboot-volatile IPC snapshot used by the production
 * web process to sample metrics owned by the separate worker process.
 * @param environment Runtime environment used to resolve the volatile root.
 * @returns Snapshot path in production when a safe runtime root is available.
 */
export function resolveCacheRefreshMetricsSnapshotPath(
    environment: Record<string, string | undefined> = process.env
): string | undefined {
    if (environment.NODE_ENV !== "production") return undefined;
    const root = runtimeDirectory(environment);
    if (!root || !path.isAbsolute(root) || path.parse(root).root === root) {
        return undefined;
    }
    return path.join(root, RUNTIME_DIRECTORY_NAME, SNAPSHOT_FILE_NAME);
}

function metricsSnapshot(): CacheRefreshMetrics {
    return {
        ...cacheRefreshMetricsState,
        averageDurationMs:
            cacheRefreshMetricsState.refreshes === 0
                ? 0
                : Math.round(
                      (cacheRefreshMetricsState.totalDurationMs /
                          cacheRefreshMetricsState.refreshes) *
                          100
                  ) / 100,
    };
}

function ensurePrivateRuntimeDirectory(directoryPath: string): void {
    fs.mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    const stat = fs.lstatSync(directoryPath);
    if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        fs.realpathSync(directoryPath) !== path.resolve(directoryPath)
    ) {
        throw new TypeError(
            `Cache refresh metrics runtime path must be a real directory: ${directoryPath}`
        );
    }
    fs.chmodSync(directoryPath, 0o700);
}

function writeSnapshot(
    snapshotPath: string,
    snapshot: CacheRefreshMetricsSnapshot
): void {
    const directoryPath = path.dirname(snapshotPath);
    ensurePrivateRuntimeDirectory(directoryPath);
    const temporaryPath = path.join(
        directoryPath,
        `.${SNAPSHOT_FILE_NAME}.${process.pid}.${Bun.randomUUIDv7()}.tmp`
    );
    let temporaryCreated = false;
    try {
        fs.writeFileSync(temporaryPath, `${JSON.stringify(snapshot)}\n`, {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        temporaryCreated = true;
        fs.renameSync(temporaryPath, snapshotPath);
        temporaryCreated = false;
    } finally {
        if (temporaryCreated) {
            fs.rmSync(temporaryPath, { force: true });
        }
    }
}

function publishSnapshot(): void {
    if (!activeSession?.snapshotPath) return;
    writeSnapshot(activeSession.snapshotPath, {
        instanceId: activeSession.instanceId,
        metrics: metricsSnapshot(),
        pid: process.pid,
        startedAt: activeSession.startedAt,
        version: CACHE_REFRESH_METRICS_SNAPSHOT_VERSION,
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function readSnapshot(snapshotPath: string): CacheRefreshMetricsSnapshot | undefined {
    let descriptor: number | undefined;
    try {
        descriptor = fs.openSync(
            snapshotPath,
            fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        const stat = fs.fstatSync(descriptor);
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size <= 0 ||
            stat.size > MAX_CACHE_REFRESH_METRICS_SNAPSHOT_BYTES
        ) {
            return undefined;
        }
        const value: unknown = JSON.parse(fs.readFileSync(descriptor, "utf8"));
        if (
            !isRecord(value) ||
            value.version !== CACHE_REFRESH_METRICS_SNAPSHOT_VERSION ||
            typeof value.instanceId !== "string" ||
            typeof value.startedAt !== "string" ||
            typeof value.pid !== "number" ||
            !Number.isSafeInteger(value.pid) ||
            value.pid <= 0 ||
            !isProcessAlive(value.pid)
        ) {
            return undefined;
        }
        const parsedMetrics = v.safeParse(cacheRefreshMetricsSchema, value.metrics);
        if (!parsedMetrics.success) return undefined;
        return {
            instanceId: value.instanceId,
            metrics: parsedMetrics.output,
            pid: value.pid,
            startedAt: value.startedAt,
            version: CACHE_REFRESH_METRICS_SNAPSHOT_VERSION,
        };
    } catch {
        return undefined;
    } finally {
        if (descriptor !== undefined) {
            fs.closeSync(descriptor);
        }
    }
}

/**
 * Starts a fresh in-memory metrics session and publishes its zero snapshot for
 * production IPC. Repeated registration inside the same worker is idempotent.
 */
export function startCacheRefreshMetricsSession(
    options: CacheRefreshMetricsSessionOptions = {}
): void {
    if (activeSession) return;
    cacheRefreshMetricsState = emptyCacheRefreshMetrics();
    activeSession = {
        instanceId: Bun.randomUUIDv7(),
        snapshotPath:
            options.snapshotPath ??
            resolveCacheRefreshMetricsSnapshotPath(options.environment ?? process.env),
        startedAt: new Date().toISOString(),
    };
    publishSnapshot();
}

/**
 * Removes only this worker instance's volatile snapshot. A replacement worker
 * that has already published a newer instance is left intact.
 */
export function stopCacheRefreshMetricsSession(): void {
    const session = activeSession;
    activeSession = undefined;
    if (!session?.snapshotPath) return;
    const current = readSnapshot(session.snapshotPath);
    if (current?.instanceId !== session.instanceId) return;
    try {
        fs.unlinkSync(session.snapshotPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
}

/**
 * Returns runtime-only cache producer metrics for the active worker session.
 * @param options Environment and snapshot overrides.
 * @returns Current runtime metrics or an empty snapshot when unavailable.
 */
export function getCacheRefreshMetrics(
    options: CacheRefreshMetricsSessionOptions = {}
): CacheRefreshMetrics {
    if (activeSession || (options.environment ?? process.env).NODE_ENV !== "production") {
        return metricsSnapshot();
    }
    const snapshotPath =
        options.snapshotPath ??
        resolveCacheRefreshMetricsSnapshotPath(options.environment ?? process.env);
    return (
        (snapshotPath && readSnapshot(snapshotPath)?.metrics) ||
        emptyCacheRefreshMetrics()
    );
}

/** Records one producer request before abort or coalescing decisions. */
export function recordCacheRefreshRequest(): void {
    cacheRefreshMetricsState.requests += 1;
    publishSnapshot();
}

/** Records a request that shares an already-running producer. */
export function recordCacheRefreshCoalesced(): void {
    cacheRefreshMetricsState.coalesced += 1;
    publishSnapshot();
}

/** Records the start of one real cache producer invocation. */
export function recordCacheRefreshStarted(): void {
    cacheRefreshMetricsState.active += 1;
    cacheRefreshMetricsState.refreshes += 1;
    publishSnapshot();
}

/**
 * Records producer settlement and bounded duration aggregates.
 * @param durationMs Producer duration.
 * @param failed Whether the producer rejected.
 */
export function recordCacheRefreshFinished(durationMs: number, failed: boolean): void {
    const boundedDuration =
        Math.round(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0) * 100) / 100;
    cacheRefreshMetricsState.active = Math.max(0, cacheRefreshMetricsState.active - 1);
    cacheRefreshMetricsState.failures += failed ? 1 : 0;
    cacheRefreshMetricsState.lastDurationMs = boundedDuration;
    cacheRefreshMetricsState.maxDurationMs = Math.max(
        cacheRefreshMetricsState.maxDurationMs,
        boundedDuration
    );
    cacheRefreshMetricsState.totalDurationMs += boundedDuration;
    publishSnapshot();
}

/** Resets module state between isolated tests. */
export function resetCacheRefreshMetricsForTests(): void {
    stopCacheRefreshMetricsSession();
    cacheRefreshMetricsState = emptyCacheRefreshMetrics();
}
