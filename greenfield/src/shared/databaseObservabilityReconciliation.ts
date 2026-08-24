/** Redacted outcomes from the fixed approval-bound catalog reconciler. */
export const databaseObservabilityReconciliationStatuses = [
    "reconciled",
    "unchanged",
    "unavailable",
] as const;

export type DatabaseObservabilityReconciliationStatus =
    (typeof databaseObservabilityReconciliationStatuses)[number];

/** Fixed redacted failure for acquire/close process or result drift. */
export class DatabaseObservabilityCollectionLeaseError extends Error {
    constructor() {
        super("Database observability collection lease is unavailable");
        this.name = "DatabaseObservabilityCollectionLeaseError";
    }
}

/** Result returned only after the mandatory fail-closed lease cleanup succeeds. */
export interface DatabaseObservabilityApprovedCollectionResult<T> {
    readonly reconciliationStatus: DatabaseObservabilityReconciliationStatus;
    readonly value: T;
}

/** Worker-only lease authority; credentials, paths, and commands never cross it. */
export interface DatabaseObservabilityReconciliationPort {
    readonly withApprovedCollection: <T>(
        operation: (
            reconciliationStatus: DatabaseObservabilityReconciliationStatus,
            signal: AbortSignal
        ) => Promise<T>,
        signal?: AbortSignal
    ) => Promise<DatabaseObservabilityApprovedCollectionResult<T>>;
}
