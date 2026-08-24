import type { GatewaySession } from "../../../contracts/gatewaySessions.ts";

/** Bounded current-session projection returned by a concrete OpenClaw adapter. */
export interface GatewaySessionProviderSnapshot {
    /** True when OpenClaw has more current rows than the requested limit. */
    readonly truncated: boolean;
    readonly sessions: readonly GatewaySession[];
}

export interface GatewaySessionProviderRequest {
    readonly limit: number;
    readonly signal?: AbortSignal;
}

export interface GatewaySessionProviderActionRequest {
    readonly key: string;
    readonly signal?: AbortSignal;
}

export interface GatewaySessionProviderDeleteRequest extends GatewaySessionProviderActionRequest {
    readonly expectedSessionId: string;
    readonly expectedUpdatedAtMs?: number;
}

export type GatewaySessionProviderCompactOutcome = "compacted" | "unchanged";

/**
 * High-level OpenClaw session authority. It intentionally exposes only the four
 * operations owned by this domain and cannot forward arbitrary Gateway methods.
 */
export interface GatewaySessionsProvider {
    readonly compactSession: (
        request: GatewaySessionProviderActionRequest
    ) => Promise<GatewaySessionProviderCompactOutcome>;
    readonly deleteSessionTranscript: (
        request: GatewaySessionProviderDeleteRequest
    ) => Promise<void>;
    readonly listCurrentSessions: (
        request: GatewaySessionProviderRequest
    ) => Promise<GatewaySessionProviderSnapshot>;
    readonly resetSession: (
        request: GatewaySessionProviderActionRequest
    ) => Promise<void>;
}

/** Typed provider rejection for an identity that no longer exists upstream. */
export class GatewaySessionProviderNotFoundError extends Error {
    public constructor() {
        super("Gateway session was not found");
        this.name = "GatewaySessionProviderNotFoundError";
    }
}

/** Typed provider rejection for a session that changed during an action. */
export class GatewaySessionProviderConflictError extends Error {
    public constructor() {
        super("Gateway session changed");
        this.name = "GatewaySessionProviderConflictError";
    }
}

/** Safe provider rejection used when the caller cancels an in-flight RPC. */
export class GatewaySessionProviderAbortError extends Error {
    public constructor() {
        super("Gateway session request was aborted");
        this.name = "AbortError";
    }
}

/** A control may have executed, but its acknowledgement could not be confirmed. */
export class GatewaySessionProviderUnknownOutcomeError extends Error {
    public constructor() {
        super("Gateway session control outcome is unknown");
        this.name = "GatewaySessionProviderUnknownOutcomeError";
    }
}

/** Safe provider rejection for transport, deadline, or response-validation failures. */
export class GatewaySessionProviderUnavailableError extends Error {
    public constructor() {
        super("Gateway session provider is unavailable");
        this.name = "GatewaySessionProviderUnavailableError";
    }
}
