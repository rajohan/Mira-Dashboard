import * as v from "valibot";

import {
    type GatewaySession,
    type GatewaySessionAction,
    type GatewaySessionActionInput,
    type GatewaySessionActionResult,
    type GatewaySessionDeleteInput,
    type GatewaySessionFilter,
    type ListGatewaySessionsInput,
    type ListGatewaySessionsResult,
    compareGatewaySessions,
    deriveGatewaySessionStats,
    gatewaySessionActionInputSchema,
    gatewaySessionActionResultSchema,
    gatewaySessionDeleteInputSchema,
    gatewaySessionPageSchema,
    gatewayPrimarySessionKey,
    gatewaySessionProjectionMaximum,
    gatewaySessionSchema,
    listGatewaySessionsInputSchema,
    listGatewaySessionsResultSchema,
} from "../../../contracts/gatewaySessions.ts";
import { timestampMillisecondsSchema } from "../../../shared/dateTime.ts";
import {
    type GatewaySessionControlAuditPort,
    type GatewaySessionControlRequestContext,
    unavailableGatewaySessionControlAudit,
} from "./controlAudit.ts";
import {
    GatewaySessionConflictError,
    GatewaySessionControlForbiddenError,
    GatewaySessionControlUnknownOutcomeError,
    GatewaySessionControlUnavailableError,
    GatewaySessionNotFoundError,
    GatewaySessionsUnavailableError,
} from "./errors.ts";
import {
    GatewaySessionProviderConflictError,
    GatewaySessionProviderNotFoundError,
    GatewaySessionProviderUnknownOutcomeError,
    type GatewaySessionProviderSnapshot,
    type GatewaySessionsProvider,
} from "./provider.ts";
import {
    type GatewaySessionTranscriptLifecyclePort,
    unavailableGatewaySessionTranscriptLifecycle,
} from "./transcriptLifecycle.ts";

interface LastKnownGoodProjection {
    readonly observedAtMs: number;
    readonly projectionTruncated: boolean;
    readonly sessions: readonly GatewaySession[];
}

class GatewaySessionsRefreshInvalidatedError extends Error {
    constructor() {
        super("Gateway sessions refresh was invalidated by a confirmed control");
        this.name = "GatewaySessionsRefreshInvalidatedError";
    }
}

export interface GatewaySessionsService {
    readonly compact: (
        input: GatewaySessionActionInput,
        context: GatewaySessionControlRequestContext,
        signal?: AbortSignal
    ) => Promise<GatewaySessionActionResult>;
    readonly delete: (
        input: GatewaySessionDeleteInput,
        context: GatewaySessionControlRequestContext,
        signal?: AbortSignal
    ) => Promise<GatewaySessionActionResult>;
    readonly list: (
        input: ListGatewaySessionsInput,
        signal?: AbortSignal
    ) => Promise<ListGatewaySessionsResult>;
    readonly reset: (
        input: GatewaySessionActionInput,
        context: GatewaySessionControlRequestContext,
        signal?: AbortSignal
    ) => Promise<GatewaySessionActionResult>;
}

/** Identity-free process-local projection consumed by the compact ops heartbeat. */
export type GatewaySessionsHeartbeatProjection =
    | Readonly<{ state: "unavailable" }>
    | Readonly<{
          count: number;
          observedAtMs: number;
          state: "fresh";
          truncated: boolean;
      }>
    | Readonly<{
          count: number;
          observedAtMs: number;
          staleSinceMs: number;
          state: "last-known-good";
          truncated: boolean;
      }>;

/** Non-fetching summary seam; it never exposes session identity or upstream payloads. */
export interface GatewaySessionsHeartbeatReader {
    readonly readHeartbeatProjection: () => GatewaySessionsHeartbeatProjection;
    readonly refreshHeartbeatProjection?: () => Promise<void>;
}

export interface GatewaySessionsServiceDependencies {
    readonly controlAudit?: GatewaySessionControlAuditPort;
    readonly nowMs?: () => number;
    readonly provider: GatewaySessionsProvider;
    readonly transcriptLifecycle?: GatewaySessionTranscriptLifecyclePort;
}

const clockSchema = timestampMillisecondsSchema("Gateway session clock is invalid");

function parseClock(nowMs: () => number): number {
    return v.parse(clockSchema, nowMs());
}

function parseProviderSnapshot(
    snapshot: GatewaySessionProviderSnapshot,
    observedAtMs: number
): LastKnownGoodProjection {
    const sessions = v.parse(
        v.pipe(
            v.array(
                gatewaySessionSchema,
                "Gateway provider session projection is invalid"
            ),
            v.maxLength(
                gatewaySessionProjectionMaximum,
                "Gateway provider session projection is outside its budget"
            )
        ),
        [...snapshot.sessions]
    );
    const uniqueKeys = new Set(sessions.map(({ key }) => key));
    if (uniqueKeys.size !== sessions.length) {
        throw new TypeError("Gateway provider returned duplicate session identities");
    }
    const ordered = v.parse(
        gatewaySessionPageSchema,
        sessions.toSorted(compareGatewaySessions)
    );
    return {
        observedAtMs,
        projectionTruncated: v.parse(v.boolean(), snapshot.truncated),
        sessions: ordered,
    };
}

function gatewaySessionMatchesFilter(
    session: GatewaySession,
    filter: GatewaySessionFilter
): boolean {
    return filter === "ALL" || session.kind === filter.toLowerCase();
}

function snapshotStats(
    sessions: readonly GatewaySession[],
    observedAtMs: number
): ListGatewaySessionsResult["stats"] {
    return deriveGatewaySessionStats(sessions, observedAtMs);
}

function publicSnapshot(
    projection: LastKnownGoodProjection,
    input: ListGatewaySessionsInput,
    source:
        | Readonly<{
              checkedAtMs: number;
              connection: "connected";
              freshness: "fresh";
              observedAtMs: number;
          }>
        | Readonly<{
              checkedAtMs: number;
              connection: "disconnected";
              freshness: "stale";
              observedAtMs: number;
          }>
): ListGatewaySessionsResult {
    const sessions = projection.sessions.filter((session) =>
        gatewaySessionMatchesFilter(session, input.filter)
    );
    return v.parse(listGatewaySessionsResultSchema, {
        filter: input.filter,
        projectionTruncated: projection.projectionTruncated,
        sessions,
        source,
        stats: snapshotStats(sessions, projection.observedAtMs),
    });
}

function staleSnapshot(
    projection: LastKnownGoodProjection,
    input: ListGatewaySessionsInput,
    checkedAtMs: number
): ListGatewaySessionsResult {
    return publicSnapshot(projection, input, {
        checkedAtMs: Math.max(checkedAtMs, projection.observedAtMs),
        connection: "disconnected",
        freshness: "stale",
        observedAtMs: projection.observedAtMs,
    });
}

function freshSnapshot(
    projection: LastKnownGoodProjection,
    input: ListGatewaySessionsInput
): ListGatewaySessionsResult {
    return publicSnapshot(projection, input, {
        checkedAtMs: projection.observedAtMs,
        connection: "connected",
        freshness: "fresh",
        observedAtMs: projection.observedAtMs,
    });
}

function throwControlFailure(error: unknown): never {
    if (error instanceof GatewaySessionProviderNotFoundError) {
        throw new GatewaySessionNotFoundError();
    }
    if (error instanceof GatewaySessionProviderConflictError) {
        throw new GatewaySessionConflictError();
    }
    if (error instanceof GatewaySessionProviderUnknownOutcomeError) {
        throw new GatewaySessionControlUnknownOutcomeError();
    }
    throw new GatewaySessionControlUnavailableError();
}

/**
 * Creates the bounded current-session service with one process-local last-known-good cache.
 * @param dependencies High-level OpenClaw authority and validated clock.
 * @returns Frozen session reads and explicit controls.
 */
export function createGatewaySessionsService(
    dependencies: GatewaySessionsServiceDependencies
): GatewaySessionsService & GatewaySessionsHeartbeatReader {
    const controlAudit =
        dependencies.controlAudit ?? unavailableGatewaySessionControlAudit;
    const transcriptLifecycle =
        dependencies.transcriptLifecycle ?? unavailableGatewaySessionTranscriptLifecycle;
    const nowMs = dependencies.nowMs ?? Date.now;
    let lastKnownGood: LastKnownGoodProjection | undefined;
    let nextRefreshGeneration = 0;
    let committedRefreshGeneration = 0;
    let mutationEpoch = 0;
    let projectionStaleSinceMs: number | undefined;
    let heartbeatRefresh: Promise<void> | undefined;

    function markProjectionStale(candidateCheckedAtMs?: number): void {
        const projection = lastKnownGood;
        if (projection === undefined) return;
        let checkedAtMs = projection.observedAtMs;
        try {
            checkedAtMs =
                candidateCheckedAtMs === undefined
                    ? parseClock(nowMs)
                    : v.parse(clockSchema, candidateCheckedAtMs);
        } catch {
            // Heartbeat bookkeeping cannot change an already-known domain outcome.
        }
        projectionStaleSinceMs =
            projectionStaleSinceMs ?? Math.max(checkedAtMs, projection.observedAtMs);
    }

    function readHeartbeatProjection(): GatewaySessionsHeartbeatProjection {
        const projection = lastKnownGood;
        if (projection === undefined) return Object.freeze({ state: "unavailable" });
        const shared = {
            count: projection.sessions.length,
            observedAtMs: projection.observedAtMs,
            truncated: projection.projectionTruncated,
        };
        return projectionStaleSinceMs === undefined
            ? Object.freeze({ ...shared, state: "fresh" })
            : Object.freeze({
                  ...shared,
                  staleSinceMs: projectionStaleSinceMs,
                  state: "last-known-good",
              });
    }

    async function refresh(signal?: AbortSignal): Promise<LastKnownGoodProjection> {
        signal?.throwIfAborted();
        const refreshGeneration = (nextRefreshGeneration += 1);
        const refreshMutationEpoch = mutationEpoch;
        const observedAtMs = parseClock(nowMs);
        let providerSnapshot: GatewaySessionProviderSnapshot;
        try {
            providerSnapshot = await dependencies.provider.listCurrentSessions({
                limit: gatewaySessionProjectionMaximum,
                ...(signal === undefined ? {} : { signal }),
            });
        } catch (error) {
            if (!signal?.aborted && refreshGeneration >= committedRefreshGeneration) {
                markProjectionStale();
            }
            throw error;
        }
        const projection = parseProviderSnapshot(providerSnapshot, observedAtMs);
        if (refreshMutationEpoch !== mutationEpoch) {
            if (refreshGeneration >= committedRefreshGeneration) {
                markProjectionStale(observedAtMs);
            }
            throw new GatewaySessionsRefreshInvalidatedError();
        }
        try {
            await transcriptLifecycle.observeSnapshot({
                observedAtMs: projection.observedAtMs,
                projectionTruncated: projection.projectionTruncated,
                sessions: projection.sessions.map(({ key, sessionId, updatedAtMs }) => ({
                    key,
                    ...(sessionId === undefined ? {} : { sessionId }),
                    ...(updatedAtMs === undefined ? {} : { updatedAtMs }),
                })),
            });
        } catch {
            markProjectionStale(observedAtMs);
            throw new GatewaySessionsRefreshInvalidatedError();
        }
        if (refreshGeneration >= committedRefreshGeneration) {
            committedRefreshGeneration = refreshGeneration;
            lastKnownGood = projection;
            projectionStaleSinceMs = undefined;
        }
        return lastKnownGood ?? projection;
    }

    async function refreshHeartbeatProjection(): Promise<void> {
        heartbeatRefresh ??= (async () => {
            try {
                await refresh();
            } catch {
                // The heartbeat projection exposes unavailable or stale state.
            } finally {
                heartbeatRefresh = undefined;
            }
        })();
        await heartbeatRefresh;
    }

    async function list(
        rawInput: ListGatewaySessionsInput,
        signal?: AbortSignal
    ): Promise<ListGatewaySessionsResult> {
        const input = v.parse(listGatewaySessionsInputSchema, rawInput);
        try {
            return freshSnapshot(await refresh(signal), input);
        } catch (error) {
            if (signal?.aborted) throw error;
            const projection = lastKnownGood;
            if (projection === undefined) throw new GatewaySessionsUnavailableError();
            return staleSnapshot(projection, input, parseClock(nowMs));
        }
    }

    async function refreshAfterControl(
        signal?: AbortSignal
    ): Promise<GatewaySessionActionResult["refresh"]> {
        try {
            return {
                snapshot: freshSnapshot(await refresh(signal), { filter: "ALL" }),
                status: "available",
            };
        } catch {
            const projection = lastKnownGood;
            return projection === undefined
                ? { status: "unavailable" }
                : {
                      snapshot: staleSnapshot(
                          projection,
                          { filter: "ALL" },
                          parseClock(nowMs)
                      ),
                      status: "available",
                  };
        }
    }

    async function perform(
        action: GatewaySessionAction,
        rawInput: GatewaySessionActionInput | GatewaySessionDeleteInput,
        context: GatewaySessionControlRequestContext,
        signal?: AbortSignal
    ): Promise<GatewaySessionActionResult> {
        signal?.throwIfAborted();
        const input =
            action === "delete"
                ? v.parse(gatewaySessionDeleteInputSchema, rawInput)
                : v.parse(gatewaySessionActionInputSchema, rawInput);
        let attempt;
        try {
            attempt = await controlAudit.begin({ action, context, key: input.key });
        } catch {
            throw new GatewaySessionControlUnavailableError();
        }
        if (action === "delete" && input.key === gatewayPrimarySessionKey) {
            await controlAudit.settle(attempt, "failed");
            throw new GatewaySessionControlForbiddenError();
        }
        const controlId = context.requestId;
        try {
            await transcriptLifecycle.beginControl({
                action,
                controlId,
                key: input.key,
                occurredAtMs: parseClock(nowMs),
            });
        } catch {
            await controlAudit.settle(attempt, "failed");
            throw new GatewaySessionControlUnavailableError();
        }
        let outcome: GatewaySessionActionResult["outcome"] = "changed";
        try {
            const request = {
                key: input.key,
                ...(signal === undefined ? {} : { signal }),
            };
            switch (action) {
                case "compact": {
                    outcome =
                        (await dependencies.provider.compactSession(request)) ===
                        "compacted"
                            ? "changed"
                            : "unchanged";
                    break;
                }
                case "reset": {
                    await dependencies.provider.resetSession(request);
                    break;
                }
                case "delete": {
                    const deleteInput = v.parse(gatewaySessionDeleteInputSchema, input);
                    await dependencies.provider.deleteSessionTranscript({
                        ...request,
                        expectedSessionId: deleteInput.expectedSessionId,
                        ...(deleteInput.expectedUpdatedAtMs === undefined
                            ? {}
                            : {
                                  expectedUpdatedAtMs: deleteInput.expectedUpdatedAtMs,
                              }),
                    });
                    break;
                }
            }
        } catch (error) {
            const unknownOutcome =
                error instanceof GatewaySessionProviderUnknownOutcomeError;
            if (unknownOutcome) {
                // The provider may have mutated. Fence every refresh that began
                // before this ambiguity, retain identities, and force reconciliation.
                mutationEpoch += 1;
                markProjectionStale();
            } else {
                try {
                    await transcriptLifecycle.failControl({
                        action,
                        controlId,
                        key: input.key,
                        occurredAtMs: parseClock(nowMs),
                    });
                } catch {
                    // A failed local settlement remains fail-closed behind the
                    // already-durable pending transcript boundary.
                }
            }
            await controlAudit.settle(attempt, unknownOutcome ? "partial" : "failed");
            if (unknownOutcome) throwControlFailure(error);
            if (signal?.aborted) throw error;
            throwControlFailure(error);
        }
        if (action === "compact" && outcome === "unchanged") {
            try {
                await transcriptLifecycle.settleUnchangedControl({
                    action,
                    controlId,
                    key: input.key,
                    occurredAtMs: parseClock(nowMs),
                });
            } catch {
                await controlAudit.settle(attempt, "partial");
                throw new GatewaySessionControlUnavailableError();
            }
        }
        if (action !== "compact" || outcome === "changed") {
            // Establish the mutation barrier before any terminal audit or refresh
            // await. A pre-control refresh can no longer commit stale identities.
            mutationEpoch += 1;
            if (action === "delete" && lastKnownGood !== undefined) {
                lastKnownGood = {
                    ...lastKnownGood,
                    sessions: lastKnownGood.sessions.filter(
                        ({ key }) => key !== input.key
                    ),
                };
            }
            markProjectionStale();
        }
        await controlAudit.settle(attempt, "succeeded");
        return v.parse(gatewaySessionActionResultSchema, {
            action,
            key: input.key,
            outcome,
            refresh: await refreshAfterControl(signal),
        });
    }

    const service: GatewaySessionsService & GatewaySessionsHeartbeatReader = {
        compact: (
            input: GatewaySessionActionInput,
            context: GatewaySessionControlRequestContext,
            signal?: AbortSignal
        ) => perform("compact", input, context, signal),
        delete: (
            input: GatewaySessionDeleteInput,
            context: GatewaySessionControlRequestContext,
            signal?: AbortSignal
        ) => perform("delete", input, context, signal),
        list,
        readHeartbeatProjection,
        refreshHeartbeatProjection,
        reset: (
            input: GatewaySessionActionInput,
            context: GatewaySessionControlRequestContext,
            signal?: AbortSignal
        ) => perform("reset", input, context, signal),
    };
    return Object.freeze(service);
}
