/** Complete contract-ordered inventory of reviewed privileged host operations. */
export const hostOperationIds = Object.freeze([
    "system-restart",
    "system-update",
] as const);

/** One exact reviewed privileged host operation. */
export type HostOperationId = (typeof hostOperationIds)[number];

/** Secret-free result returned by one future, separately privileged host adapter. */
export type FixedHostOperationResult =
    | Readonly<{ status: "accepted" }>
    | Readonly<{ status: "completed" }>;

/** Worker-only fixed-operation authority; no command or path crosses this port. */
export interface FixedHostOperationsExecutionPort {
    readonly availableOperations: (
        signal?: AbortSignal
    ) => Promise<readonly HostOperationId[]>;
    readonly request: (
        operationId: HostOperationId,
        signal?: AbortSignal
    ) => Promise<FixedHostOperationResult>;
}
