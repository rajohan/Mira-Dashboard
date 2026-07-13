import { json } from "../http.ts";
import {
    type CacheEntryRow,
    getAllCacheEntries,
    getCacheEntry,
    getCacheStatusEntries,
    parseJsonField,
} from "../lib/cacheStore.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { stringFallback } from "../lib/values.ts";
import { refreshCacheProducer } from "../services/cacheRefresh.ts";

function parseJsonFieldOrValue(value: string) {
    const parsed = parseJsonField<unknown>(value);
    return parsed ?? value;
}

export function compactHeartbeatData(key: string, data: unknown): unknown {
    const missingValue = JSON.parse("null") as null;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return missingValue;
    }
    const value = data as Record<string, unknown>;
    switch (key) {
        case "backup.kopia.status": {
            return {
                checkedAt: value.checkedAt,
                isOk: value.isOk,
                latest: Array.isArray(value.latest)
                    ? value.latest.map((snapshot) => {
                          const item = snapshot as Record<string, unknown>;
                          return {
                              endTime: item.endTime,
                              errorCount: item.errorCount,
                              ignoredErrorCount: item.ignoredErrorCount,
                              path: item.path,
                          };
                      })
                    : [],
                stale: value.stale,
            };
        }
        case "backup.walg.status": {
            return {
                backupCount: value.backupCount,
                checkedAt: value.checkedAt,
                isOk: value.isOk,
                latest: value.latest,
                latestAgeHours: value.latestAgeHours,
                stale: value.stale,
            };
        }
        case "database.summary": {
            return {
                checkedAt: value.checkedAt,
                databases: Array.isArray(value.databases)
                    ? value.databases.map((database) => {
                          const item = database as Record<string, unknown>;
                          return {
                              cacheHitRatio: item.cache_hit_ratio,
                              name: item.datname,
                              connections: item.numbackends,
                              sizeBytes: item.size_bytes,
                          };
                      })
                    : [],
                overview: value.overview,
            };
        }
        case "docker.summary": {
            return {
                checkedAt: value.checkedAt,
                containers: Array.isArray(value.containers)
                    ? value.containers.map((container) => {
                          const item = container as Record<string, unknown>;
                          return {
                              health: item.health,
                              name: item.name,
                              restartCount: item.restartCount,
                              state: item.state,
                              status: item.status,
                          };
                      })
                    : [],
                updaterSummary: value.updaterSummary,
            };
        }
        case "log_rotation.state": {
            const lastRun =
                value.lastRun && typeof value.lastRun === "object"
                    ? (value.lastRun as Record<string, unknown>)
                    : {};
            return {
                lastRun: {
                    errors: lastRun.errors,
                    finishedAt: lastRun.finishedAt,
                    isOk: lastRun.isOk,
                    skippedFiles: lastRun.skippedFiles,
                    warnings: lastRun.warnings,
                },
            };
        }
        case "system.openclaw": {
            const gateway =
                value.gateway && typeof value.gateway === "object"
                    ? (value.gateway as Record<string, unknown>)
                    : {};
            const gatewayService =
                value.gatewayService && typeof value.gatewayService === "object"
                    ? (value.gatewayService as Record<string, unknown>)
                    : {};
            const nodeService =
                value.nodeService && typeof value.nodeService === "object"
                    ? (value.nodeService as Record<string, unknown>)
                    : {};
            const security =
                value.security && typeof value.security === "object"
                    ? (value.security as Record<string, unknown>)
                    : {};
            return {
                checkedAt: value.checkedAt,
                doctorError: value.doctorError,
                doctorWarningCount: value.doctorWarningCount,
                doctorWarnings: value.doctorWarnings,
                gateway: {
                    authWarning: gateway.authWarning,
                    error: gateway.error,
                    reachable: gateway.reachable,
                    status: gateway.status,
                },
                gatewayService: {
                    active: gatewayService.active,
                    loaded: gatewayService.loaded,
                    runtime: gatewayService.runtime,
                    runtimeShort: gatewayService.runtimeShort,
                },
                heartbeat: value.heartbeat,
                nodeService: {
                    active: nodeService.active,
                    loaded: nodeService.loaded,
                    runtime: nodeService.runtime,
                    runtimeShort: nodeService.runtimeShort,
                },
                security: {
                    findings: Array.isArray(security.findings)
                        ? security.findings.map((finding) => {
                              const item = finding as Record<string, unknown>;
                              return {
                                  checkId: item.checkId,
                                  severity: item.severity,
                                  title: item.title,
                              };
                          })
                        : [],
                    isOk: security.isOk,
                    summary: security.summary,
                },
                securityError: value.securityError,
                taskAudit: value.taskAudit,
                tasks: value.tasks,
                updateStatusError: value.updateStatusError,
                version: value.version,
            };
        }
        case "git.workspace":
        case "moltbook.home":
        case "quotas.summary":
        case "system.host":
        case "weather.spydeberg": {
            return value;
        }
        default: {
            return missingValue;
        }
    }
}

function mapCacheRowForResponse(
    row: CacheEntryRow,
    options: { includeData?: boolean } = {}
) {
    const missingValue = JSON.parse("null") as null;
    return {
        consecutiveFailures: Number(row.consecutive_failures ?? 0),
        data:
            options.includeData === false
                ? missingValue
                : parseJsonFieldOrValue(row.data),
        errorCode: row.error_code ?? missingValue,
        errorMessage: row.error_message ?? missingValue,
        expiresAt: row.expires_at ?? missingValue,
        key: row.key,
        lastAttemptAt: row.last_attempt_at ?? missingValue,
        meta: parseJsonField<unknown>(row.meta) ?? {},
        source: row.source,
        status: row.status,
        updatedAt: row.updated_at ?? missingValue,
    };
}

async function refreshCacheKey(key: string) {
    const result = await refreshCacheProducer(key);
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
    const row = await getCacheEntry(refreshedKey);
    if (!row) {
        throw new Error(`Cache key not found after refresh: ${refreshedKey}`);
    }
    return mapCacheRowForResponse(row);
}

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

export const cacheRoutes = {
    "/api/cache/heartbeat": {
        GET: async () => {
            const rows = await getAllCacheEntries();
            const entries = rows.map((row) => {
                const entry = mapCacheRowForResponse(row);
                return {
                    ...entry,
                    data: compactHeartbeatData(entry.key, entry.data),
                };
            });
            return json({
                count: entries.length,
                entries,
                generatedAt: new Date().toISOString(),
                schemaVersion: 2,
            });
        },
    },
    "/api/cache/status": {
        GET: async () => {
            const rows = await getCacheStatusEntries();
            const entries = rows.map((row) =>
                mapCacheRowForResponse(row, { includeData: false })
            );
            return json({
                count: entries.length,
                entries,
                generatedAt: new Date().toISOString(),
            });
        },
    },
    "/api/cache/:key": {
        GET: async (request: ParametersRequest<"key">) => {
            const key = stringFallback(request.params.key).trim();
            if (!key) return json({ error: "Missing cache key" }, { status: 400 });
            const row = await getCacheEntry(key);
            if (!row) return json({ error: "Cache key not found", key }, { status: 404 });
            return json(mapCacheRowForResponse(row));
        },
    },
    "/api/cache/:key/refresh": {
        POST: async (request: ParametersRequest<"key">) => {
            const key = stringFallback(request.params.key).trim();
            if (!key) return json({ error: "Missing cache key" }, { status: 400 });
            try {
                return json({ entry: await refreshCacheKey(key), isOk: true });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Cache refresh failed") },
                    { status: httpStatusCode(error) }
                );
            }
        },
    },
} as const;
