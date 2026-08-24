/** Secret-free aggregate from one fixed source-owned OpenClaw cleanup. */
export interface OpenClawSessionsCleanupSummary {
    readonly artifactsRemoved: number;
    readonly bytesFreed: number;
    readonly diskEntriesRemoved: number;
    readonly diskFilesRemoved: number;
    readonly dmScopesRetired: number;
    readonly entriesAfter: number;
    readonly entriesBefore: number;
    readonly entriesCapped: number;
    readonly entriesPruned: number;
    readonly missingEntriesRemoved: number;
    readonly modelRunsPruned: number;
    readonly status: "completed";
    readonly storesProcessed: number;
}

/** Secret-free settlement from one fixed source-owned OpenClaw update. */
export interface OpenClawInstallationUpdateSummary {
    readonly afterVersion?: string;
    readonly beforeVersion?: string;
    readonly status: "accepted" | "completed";
}

export type OpenClawServiceActionsExecutionErrorReason =
    | "operation-failed"
    | "unknown-outcome"
    | "unavailable";

/** Sanitized worker-domain failure without upstream details or process output. */
export class OpenClawServiceActionsExecutionError extends Error {
    public readonly reason: OpenClawServiceActionsExecutionErrorReason;

    public constructor(reason: OpenClawServiceActionsExecutionErrorReason) {
        super("OpenClaw Service Action failed");
        this.name = "OpenClawServiceActionsExecutionError";
        this.reason = reason;
    }
}

/** Worker-only authority for the two reviewed OpenClaw Service Actions. */
export interface OpenClawServiceActionsExecutionPort {
    cleanupSessions(signal?: AbortSignal): Promise<OpenClawSessionsCleanupSummary>;
    updateInstallation(signal?: AbortSignal): Promise<OpenClawInstallationUpdateSummary>;
}
