import type {
    GatewaySession,
    GatewaySessionAction,
} from "../../../contracts/gatewaySessions.ts";

export type GatewaySessionTranscriptControlAction = Extract<
    GatewaySessionAction,
    "compact" | "delete" | "reset"
>;

export interface GatewaySessionTranscriptSnapshot {
    readonly observedAtMs: number;
    readonly projectionTruncated: boolean;
    readonly sessions: readonly Pick<
        GatewaySession,
        "key" | "sessionId" | "updatedAtMs"
    >[];
}

/**
 * Durable chat-side fencing around provider transcript controls. The boundary is
 * admitted after the security audit and before any upstream mutation is sent.
 */
export interface GatewaySessionTranscriptLifecyclePort {
    readonly beginControl: (input: {
        readonly action: GatewaySessionTranscriptControlAction;
        readonly controlId: string;
        readonly key: string;
        readonly occurredAtMs: number;
    }) => Promise<void>;
    readonly failControl: (input: {
        readonly action: GatewaySessionTranscriptControlAction;
        readonly controlId: string;
        readonly key: string;
        readonly occurredAtMs: number;
    }) => Promise<void>;
    readonly observeSnapshot: (
        snapshot: GatewaySessionTranscriptSnapshot
    ) => Promise<void>;
    readonly settleUnchangedControl: (input: {
        readonly action: "compact";
        readonly controlId: string;
        readonly key: string;
        readonly occurredAtMs: number;
    }) => Promise<void>;
}

/** Read-only deployments cannot dispatch transcript controls without a durable fence. */
export const unavailableGatewaySessionTranscriptLifecycle: GatewaySessionTranscriptLifecyclePort =
    Object.freeze({
        beginControl: () =>
            Promise.reject(new Error("Gateway transcript lifecycle is unavailable")),
        failControl: () => Promise.resolve(),
        observeSnapshot: () => Promise.resolve(),
        settleUnchangedControl: () => Promise.resolve(),
    });
