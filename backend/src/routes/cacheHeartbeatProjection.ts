function heartbeatRecords(value: unknown): Record<string, unknown>[] {
    return Array.isArray(value)
        ? value.filter(
              (item): item is Record<string, unknown> =>
                  item !== null && typeof item === "object" && !Array.isArray(item)
          )
        : [];
}

export function compactHeartbeatData(key: string, data: unknown): unknown {
    if (!data || typeof data !== "object" || Array.isArray(data)) {
        return null;
    }
    const value = data as Record<string, unknown>;
    switch (key) {
        case "backup.kopia.status": {
            return {
                checkedAt: value.checkedAt,
                isOk: value.isOk,
                latest: heartbeatRecords(value.latest).map((item) => {
                    return {
                        endTime: item.endTime,
                        errorCount: item.errorCount,
                        ignoredErrorCount: item.ignoredErrorCount,
                        path: item.path,
                    };
                }),
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
            const overview =
                value.overview && typeof value.overview === "object"
                    ? (value.overview as Record<string, unknown>)
                    : {};
            const maintenance =
                overview.maintenance && typeof overview.maintenance === "object"
                    ? (overview.maintenance as Record<string, unknown>)
                    : {};
            const sqlite =
                value.sqlite && typeof value.sqlite === "object"
                    ? (value.sqlite as Record<string, unknown>)
                    : {};
            const sqliteMigrations =
                sqlite.migrations && typeof sqlite.migrations === "object"
                    ? (sqlite.migrations as Record<string, unknown>)
                    : {};
            const sqlitePermissions =
                sqlite.permissions && typeof sqlite.permissions === "object"
                    ? (sqlite.permissions as Record<string, unknown>)
                    : {};
            const sqliteBackup =
                sqlite.backup && typeof sqlite.backup === "object"
                    ? (sqlite.backup as Record<string, unknown>)
                    : {};
            const attentionSources = [
                ...(maintenance.status === "review" ? ["postgresql"] : []),
                ...(sqlite.status === "review" ? ["dashboard-sqlite"] : []),
            ];
            return {
                attention: {
                    needsReview: attentionSources.length > 0,
                    sources: attentionSources,
                },
                checkedAt: value.checkedAt,
                databases: heartbeatRecords(value.databases).map((item) => {
                    return {
                        cacheHitRatio: item.cache_hit_ratio,
                        name: item.datname,
                        connections: item.numbackends,
                        sizeBytes: item.size_bytes,
                    };
                }),
                maintenance: overview.maintenance,
                overview,
                sqlite: {
                    attention: sqlite.attention,
                    backup: {
                        count: sqliteBackup.count,
                        current: sqliteBackup.current,
                        latest: sqliteBackup.latest,
                        latestAgeHours: sqliteBackup.latestAgeHours,
                        reviewAgeHours: sqliteBackup.reviewAgeHours,
                    },
                    databaseBytes: sqlite.databaseBytes,
                    freeBytes: sqlite.freeBytes,
                    freePercent: sqlite.freePercent,
                    journalMode: sqlite.journalMode,
                    lastMaintenance: sqlite.lastMaintenance,
                    migrations: {
                        applied: sqliteMigrations.applied,
                        current: sqliteMigrations.current,
                        latest: sqliteMigrations.latest,
                    },
                    permissions: {
                        secure: sqlitePermissions.secure,
                    },
                    status: sqlite.status,
                    storageBytes: sqlite.storageBytes,
                    walBytes: sqlite.walBytes,
                },
            };
        }
        case "docker.summary": {
            return {
                checkedAt: value.checkedAt,
                containers: heartbeatRecords(value.containers).map((item) => {
                    return {
                        health: item.health,
                        name: item.name,
                        restartCount: item.restartCount,
                        state: item.state,
                        status: item.status,
                    };
                }),
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
                    findings: heartbeatRecords(security.findings).map((item) => {
                        return {
                            checkId: item.checkId,
                            severity: item.severity,
                            title: item.title,
                        };
                    }),
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
            return null;
        }
    }
}
