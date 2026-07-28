interface MutableDatabaseOperationMetrics {
    lockErrors: number;
    maxDurationMs: number;
    operations: number;
    totalDurationMs: number;
}

export interface DatabaseOperationMetrics {
    averageDurationMs: number;
    lockErrors: number;
    maxDurationMs: number;
    operations: number;
}

const databaseOperationMetrics: MutableDatabaseOperationMetrics = {
    lockErrors: 0,
    maxDurationMs: 0,
    operations: 0,
    totalDurationMs: 0,
};

function isSqliteLockError(error: unknown): boolean {
    if (error === null || typeof error !== "object") return false;
    const code = Reflect.get(error, "code");
    return (
        typeof code === "string" &&
        (code.startsWith("SQLITE_BUSY") || code.startsWith("SQLITE_LOCKED"))
    );
}

/** Records one synchronous SQLite operation without retaining SQL or bindings. */
export function recordDatabaseOperation(durationMs: number, error?: unknown): void {
    const boundedDuration =
        Math.round(Math.max(0, Number.isFinite(durationMs) ? durationMs : 0) * 100) / 100;
    databaseOperationMetrics.operations += 1;
    databaseOperationMetrics.totalDurationMs += boundedDuration;
    databaseOperationMetrics.maxDurationMs = Math.max(
        databaseOperationMetrics.maxDurationMs,
        boundedDuration
    );
    if (isSqliteLockError(error)) {
        databaseOperationMetrics.lockErrors += 1;
    }
}

export function getDatabaseOperationMetrics(): DatabaseOperationMetrics {
    return {
        averageDurationMs:
            databaseOperationMetrics.operations === 0
                ? 0
                : Math.round(
                      (databaseOperationMetrics.totalDurationMs /
                          databaseOperationMetrics.operations) *
                          100
                  ) / 100,
        lockErrors: databaseOperationMetrics.lockErrors,
        maxDurationMs: databaseOperationMetrics.maxDurationMs,
        operations: databaseOperationMetrics.operations,
    };
}

export function resetDatabaseOperationMetricsForTests(): void {
    Object.assign(databaseOperationMetrics, {
        lockErrors: 0,
        maxDurationMs: 0,
        operations: 0,
        totalDurationMs: 0,
    });
}
