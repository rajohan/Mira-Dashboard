export type TerminalServiceFailureReason =
    | "audit-unavailable"
    | "capacity"
    | "conflict"
    | "gone"
    | "invalid-input"
    | "not-found"
    | "unavailable";

/** Sanitized expected terminal-domain failure safe for route classification. */
export class TerminalServiceError extends Error {
    public readonly reason: TerminalServiceFailureReason;

    public constructor(reason: TerminalServiceFailureReason, cause?: unknown) {
        super(
            "Terminal operation could not be completed",
            cause === undefined ? undefined : { cause }
        );
        this.name = "TerminalServiceError";
        this.reason = reason;
    }
}
