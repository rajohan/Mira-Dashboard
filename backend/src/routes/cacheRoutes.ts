import {
    type CacheEnvelope,
    type CacheHeartbeatResponse,
    type CacheRefreshResponse,
    type CacheStatusResponse,
    cacheStatusSchema,
} from "../../../contracts/cache.ts";
import { jsonObjectSchema, parseContract } from "../../../contracts/runtime.ts";
import { json } from "../http/core.ts";
import {
    type ParametersRequest,
    routeErrorResponse,
    routeFailureResponse,
} from "../http/routeSupport.ts";
import {
    type CacheEntryRow,
    getAllCacheEntries,
    getCacheEntry,
    getCacheStatusEntries,
    parseJsonField,
} from "../lib/cacheStore.ts";
import { httpStatusCode } from "../lib/errors.ts";
import { stringFallback } from "../lib/values.ts";
import { cacheRefreshResourceClass } from "../services/cacheRefresh/cacheProducerRegistry.ts";
import { cacheRefreshScheduledJobId } from "../services/cacheRefresh/cacheRefreshScheduler.ts";
import { getLatestScheduledJobExecution } from "../services/jobExecutionQueue/repository.ts";
import {
    enqueueAndWaitForJobExecution,
    successfulJobExecutionOutput,
    waitForJobExecution,
} from "../services/queuedJobExecution.ts";
import { enqueueScheduledJob } from "../services/scheduledJobs/enqueue.ts";
import {
    getScheduledJob,
    listScheduledJobs,
} from "../services/scheduledJobs/repository.ts";
import { getHeartbeatAutomationSnapshot } from "../services/taskAutomation.ts";
import { compactHeartbeatData } from "./cacheHeartbeatProjection.ts";

const CACHE_REFRESH_TIMEOUT_MS = 5 * 60 * 1000;

function parseJsonFieldOrValue(value: string) {
    const parsed = parseJsonField<unknown>(value);
    return parsed ?? value;
}

function compactDashboardJobs() {
    return listScheduledJobs().map((job) => ({
        actionKey: job.actionKey,
        disableIntent: job.disableIntent,
        enabled: job.enabled,
        id: job.id,
        isQueued: job.isQueued,
        isRunning: job.isRunning,
        lastRun: job.lastRun
            ? {
                  finishedAt: job.lastRun.finishedAt,
                  message: job.lastRun.message,
                  startedAt: job.lastRun.startedAt,
                  status: job.lastRun.status,
                  triggerType: job.lastRun.triggerType,
              }
            : undefined,
        name: job.name,
        nextRunAt: job.nextRunAt,
        resourceClass: job.resourceClass,
    }));
}

function mapCacheRowForResponse(
    row: CacheEntryRow,
    options: { includeData?: boolean } = {}
): CacheEnvelope<unknown> {
    return {
        consecutiveFailures: Number(row.consecutive_failures ?? 0),
        data: options.includeData === false ? null : parseJsonFieldOrValue(row.data),
        errorCode: row.error_code ?? null,
        errorMessage: row.error_message ?? null,
        expiresAt: row.expires_at ?? null,
        key: row.key,
        lastAttemptAt: row.last_attempt_at ?? null,
        meta: parseContract(
            jsonObjectSchema,
            parseJsonFieldOrValue(row.meta),
            `cache.${row.key}.meta`
        ),
        source: row.source,
        status: parseContract(cacheStatusSchema, row.status, `cache.${row.key}.status`),
        updatedAt: row.updated_at ?? null,
    };
}

function refreshedCacheEntry(key: string, result: Record<string, unknown>) {
    const refreshed = Array.isArray(result?.refreshed) ? result.refreshed : [];
    if (refreshed.length === 0) {
        throw Object.assign(new Error(`No cache keys refreshed for: ${key}`), {
            statusCode: 404,
        });
    }
    const refreshedKeys = refreshed
        .map((refreshedKey) => stringFallback(refreshedKey).trim())
        .filter((refreshedKey) => refreshedKey !== "");
    const refreshedKey = refreshedKeys.find((candidate) => candidate === key);
    if (!refreshedKey) {
        throw Object.assign(new Error(`No cache keys refreshed for: ${key}`), {
            statusCode: refreshedKeys.length > 0 ? 400 : 404,
        });
    }
    const row = getCacheEntry(refreshedKey);
    if (!row) {
        throw new Error(`Cache key not found after refresh: ${refreshedKey}`);
    }
    return mapCacheRowForResponse(row);
}

async function enqueueAndWaitForCacheRefresh(
    key: string,
    resourceClass: ReturnType<typeof cacheRefreshResourceClass>,
    signal: AbortSignal
) {
    const enqueueUnscheduledRefresh = async () =>
        await enqueueAndWaitForJobExecution(
            {
                actionKey: "cache.refresh",
                displayName: `Refresh cache: ${key}`,
                payload: { key },
                resourceClass,
                timeoutMs: CACHE_REFRESH_TIMEOUT_MS,
            },
            { signal }
        );
    const scheduledJobId = cacheRefreshScheduledJobId(key);
    if (!scheduledJobId) {
        return await enqueueUnscheduledRefresh();
    }
    let shouldCancelQueuedOnTimeout = true;
    let executionId: string | undefined;
    try {
        executionId = enqueueScheduledJob(scheduledJobId, "manual").executionId;
    } catch (error) {
        const statusCode = httpStatusCode(error);
        if (statusCode === 404) {
            return await enqueueUnscheduledRefresh();
        }
        if (statusCode !== 409) throw error;
        const existingExecution = getLatestScheduledJobExecution(scheduledJobId);
        if (!existingExecution) throw error;
        const scheduledJob = getScheduledJob(scheduledJobId);
        const canReuseExecution =
            existingExecution.status === "running" ||
            (existingExecution.status === "queued" &&
                scheduledJob !== undefined &&
                (existingExecution.triggerType === "manual" || scheduledJob.enabled));
        if (!canReuseExecution) {
            return await enqueueUnscheduledRefresh();
        }
        shouldCancelQueuedOnTimeout = false;
        executionId = existingExecution.id;
    }
    if (!executionId) {
        throw Object.assign(new Error("Scheduled cache refresh was not queued"), {
            statusCode: 500,
        });
    }
    const execution = await waitForJobExecution(executionId, {
        cancelQueuedOnTimeout: shouldCancelQueuedOnTimeout,
        signal,
        timeoutMs: CACHE_REFRESH_TIMEOUT_MS,
    });
    if (
        !shouldCancelQueuedOnTimeout &&
        execution.status === "cancelled" &&
        (execution.message === "Scheduled job was disabled before execution" ||
            execution.message === "Scheduled job was removed before execution")
    ) {
        return await enqueueUnscheduledRefresh();
    }
    return execution;
}

export const cacheRoutes = {
    "/api/cache/heartbeat": {
        GET: async () => {
            const rows = getAllCacheEntries();
            const dashboardJobs = compactDashboardJobs();
            const automation = await getHeartbeatAutomationSnapshot();
            const entries = rows.map((row) => {
                const entry = mapCacheRowForResponse(row);
                return {
                    ...entry,
                    data: compactHeartbeatData(entry.key, entry.data),
                };
            });
            return json({
                count: entries.length,
                cronJobs: {
                    dataAvailable: automation.isCronDataAvailable,
                    ...(automation.cronError && { error: automation.cronError }),
                    items: automation.cronJobs,
                },
                dashboardJobs,
                entries,
                generatedAt: new Date().toISOString(),
                schemaVersion: 3,
                tasks: automation.tasks,
            } satisfies CacheHeartbeatResponse);
        },
    },
    "/api/cache/status": {
        GET: () => {
            const rows = getCacheStatusEntries();
            const entries = rows.map((row): CacheEnvelope<null> => ({
                ...mapCacheRowForResponse(row, { includeData: false }),
                data: null,
            }));
            return json({
                count: entries.length,
                entries,
                generatedAt: new Date().toISOString(),
            } satisfies CacheStatusResponse);
        },
    },
    "/api/cache/:key": {
        GET: (request: ParametersRequest<"key">) => {
            const key = stringFallback(request.params.key).trim();
            if (!key)
                return routeFailureResponse({
                    context: "cache",
                    message: "Missing cache key",
                    status: 400,
                });
            const row = getCacheEntry(key);
            if (!row) {
                return routeFailureResponse({
                    context: "cache",
                    details: { key },
                    message: "Cache key not found",
                    status: 404,
                });
            }
            return json(mapCacheRowForResponse(row));
        },
    },
    "/api/cache/:key/refresh": {
        POST: async (request: ParametersRequest<"key">) => {
            const key = stringFallback(request.params.key).trim();
            if (!key)
                return routeFailureResponse({
                    context: "cache",
                    message: "Missing cache key",
                    status: 400,
                });
            try {
                const resourceClass = cacheRefreshResourceClass(key);
                const execution = await enqueueAndWaitForCacheRefresh(
                    key,
                    resourceClass,
                    request.signal
                );
                const entry = refreshedCacheEntry(
                    key,
                    successfulJobExecutionOutput(execution)
                );
                return json({
                    entry,
                    isOk: true,
                } satisfies CacheRefreshResponse<unknown>);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "cache_refresh_failed",
                    context: "cache.refresh",
                    message: "Cache refresh failed",
                });
            }
        },
    },
} as const;
