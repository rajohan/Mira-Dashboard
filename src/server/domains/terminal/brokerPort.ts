import type {
    TerminalDimensions,
    TerminalLocation,
    TerminalSessionSummary,
} from "../../../contracts/terminal.ts";

export interface TerminalSessionOwner {
    readonly authenticatorId: string;
    readonly id: string;
}

export interface TerminalTicketRegistration {
    readonly afterSequence: number;
    readonly expiresAtMs: number;
    readonly prefix: string;
    readonly validatorHash: string;
}

export type TerminalSessionBrokerFailureReason =
    | "capacity"
    | "conflict"
    | "gone"
    | "not-found"
    | "unavailable";

/** Sanitized process-boundary failure; it never contains shell output or a host path. */
export class TerminalSessionBrokerError extends Error {
    public readonly reason: TerminalSessionBrokerFailureReason;

    public constructor(reason: TerminalSessionBrokerFailureReason, cause?: unknown) {
        super("Terminal broker operation failed", cause === undefined ? {} : { cause });
        this.name = "TerminalSessionBrokerError";
        this.reason = reason;
    }
}

/** Web-to-worker lifecycle control. Streaming attach uses the separate broker relay port. */
export interface TerminalSessionBroker {
    readonly getActive: (
        owner: TerminalSessionOwner,
        signal?: AbortSignal
    ) => Promise<TerminalSessionSummary | undefined>;
    readonly prepareResume: (
        input: {
            readonly owner: TerminalSessionOwner;
            readonly sessionId: string;
            readonly ticket: TerminalTicketRegistration;
        },
        signal?: AbortSignal
    ) => Promise<TerminalSessionSummary>;
    readonly reserve: (
        input: {
            readonly absoluteStartingDirectory: string;
            readonly dimensions: TerminalDimensions;
            readonly location: TerminalLocation;
            readonly owner: TerminalSessionOwner;
            readonly sessionId: string;
            readonly ticket: TerminalTicketRegistration;
        },
        signal?: AbortSignal
    ) => Promise<TerminalSessionSummary>;
    readonly terminate: (
        input: {
            readonly owner: TerminalSessionOwner;
            readonly sessionId: string;
        },
        signal?: AbortSignal
    ) => Promise<void>;
}
