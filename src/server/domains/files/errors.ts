export type WorkspaceFileErrorReason =
    | "access-denied"
    | "capacity"
    | "conflict"
    | "directory-too-large"
    | "expired"
    | "invalid-input"
    | "not-found"
    | "not-file"
    | "too-large"
    | "unavailable";

/** Sanitized domain failure. Host paths and provider diagnostics remain in the cause only. */
export class WorkspaceFileError extends Error {
    public readonly reason: WorkspaceFileErrorReason;

    public constructor(reason: WorkspaceFileErrorReason, cause?: unknown) {
        super(
            "Workspace file operation failed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "WorkspaceFileError";
        this.reason = reason;
    }
}

export function workspaceFileError(
    error: unknown,
    fallback: WorkspaceFileErrorReason = "unavailable"
): WorkspaceFileError {
    return error instanceof WorkspaceFileError
        ? error
        : new WorkspaceFileError(fallback, error);
}
