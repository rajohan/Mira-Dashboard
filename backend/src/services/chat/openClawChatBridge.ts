import {
    withCanonicalOpenClawEvents,
    withCurrentCanonicalOpenClawIdentity,
} from "../../../../contracts/chat/openClawRuntimeAdapter.ts";
import {
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "../../../../contracts/chat/transport.ts";
import type { ChatRuntimeMetrics } from "../../../../contracts/metrics.ts";
import {
    DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS,
    DEFERRED_COMPACTION_SETTLEMENT_TIMEOUT_REASON,
    NESTED_COMPACTION_SETTLEMENT_GRACE_MS,
    OpenClawChatCompactionSettlements,
} from "./openClawChatCompactionSettlements.ts";
import {
    isAgentSessionKey,
    isSameSessionKey,
    normalizedSessionKey,
    OpenClawChatIdentityRegistry,
    type OpenClawChatSessionIdentity,
} from "./openClawChatIdentity.ts";
import { OpenClawChatRuntimeMetricsRecorder } from "./openClawChatMetrics.ts";
import {
    OpenClawChatPersistenceCoordinator,
    type OpenClawChatSnapshotStore,
} from "./openClawChatPersistence.ts";
import {
    asRecord,
    runtimePayloadView,
    sessionMessageActiveRunIds,
    stringField,
    withRuntimeIdentity,
} from "./openClawChatProviderAdapter.ts";
import { OpenClawChatReplayRetention } from "./openClawChatReplayRetention.ts";
import { OpenClawChatReplaySessions } from "./openClawChatReplaySessions.ts";
import { OpenClawChatRequestBoundaries } from "./openClawChatRequestBoundaries.ts";
import { OpenClawChatRequestLifecycle } from "./openClawChatRequestLifecycle.ts";
import {
    boundedCanonicalRuntimeEnvelope,
    isCompactionOnlyRun,
    MAX_BYTES_ACROSS_REPLAY,
    RETAINED_RUNTIME_EVENTS,
    type RetainedRun,
} from "./openClawChatRetention.ts";
import {
    isProvisionalRunId,
    sessionMessageRunId,
    type RepairedInterruptedRun,
} from "./openClawChatRunIdentity.ts";
import { OpenClawChatRunReconciliation } from "./openClawChatRunReconciliation.ts";

interface OpenClawChatBridgeOptions {
    gatewayConnected?: boolean;
    maxReplayBytes?: number;
    nestedCompactionSettlementGraceMs?: number;
    now?: () => number;
    onDeferredEnvelope?: (envelope: OpenClawRuntimeEnvelope) => void;
}

/**
 * Coordinates canonical provider, lifecycle, identity, retention, request
 * boundary, and persistence seams for live Gateway chat runtime replay.
 */
export class OpenClawChatBridge {
    readonly #compactionSettlements: OpenClawChatCompactionSettlements;
    readonly #identity = new OpenClawChatIdentityRegistry();
    readonly #metrics = new OpenClawChatRuntimeMetricsRecorder();
    readonly #persistence: OpenClawChatPersistenceCoordinator;
    readonly #runsBySession = new Map<string, Map<string, RetainedRun>>();
    readonly #runReconciliation: OpenClawChatRunReconciliation;
    readonly #replayRetention: OpenClawChatReplayRetention;
    readonly #replaySessions: OpenClawChatReplaySessions;
    readonly #requestLifecycle: OpenClawChatRequestLifecycle;
    readonly #requestBoundaries = new OpenClawChatRequestBoundaries(
        normalizedSessionKey,
        isSameSessionKey
    );
    readonly #now: () => number;
    #sequence = 0;
    #sequenceHydrated = false;

    constructor(
        store?: OpenClawChatSnapshotStore,
        options: OpenClawChatBridgeOptions = {}
    ) {
        const maxReplayBytes = options.maxReplayBytes ?? MAX_BYTES_ACROSS_REPLAY;
        if (!Number.isSafeInteger(maxReplayBytes) || maxReplayBytes <= 0) {
            throw new Error("Replay memory limit must be a positive safe integer");
        }
        const nestedCompactionSettlementGraceMs =
            options.nestedCompactionSettlementGraceMs ??
            NESTED_COMPACTION_SETTLEMENT_GRACE_MS;
        if (
            !Number.isSafeInteger(nestedCompactionSettlementGraceMs) ||
            nestedCompactionSettlementGraceMs <= 0
        ) {
            throw new Error(
                "Nested compaction settlement grace must be a positive safe integer"
            );
        }
        this.#now = options.now ?? (() => Date.now());
        this.#persistence = new OpenClawChatPersistenceCoordinator(store, {
            ensureSessionLoaded: (sessionKey) =>
                this.#replaySessions.ensureSessionLoaded(sessionKey),
            metrics: this.#metrics,
            snapshotFromMemory: (sessionKey) =>
                this.#replaySessions.snapshotFromMemory(sessionKey, true),
        });
        this.#compactionSettlements = new OpenClawChatCompactionSettlements({
            blockingRequestBoundary: (sessionKey) =>
                this.#requestBoundaries.blocking(sessionKey),
            gatewayConnected: options.gatewayConnected ?? true,
            getRuns: (sessionKey) =>
                this.#runsBySession.get(normalizedSessionKey(sessionKey)),
            graceMs: nestedCompactionSettlementGraceMs,
            now: this.#now,
            onDeferredEnvelope: options.onDeferredEnvelope,
            queueSession: (sessionKey) => this.#persistence.queueSession(sessionKey),
            recordSettlement: (sessionKey, runId) =>
                this.recordEvent(
                    "model.completed",
                    {
                        completionReason: DEFERRED_COMPACTION_SETTLEMENT_TIMEOUT_REASON,
                        runId,
                        sessionKey,
                        status: "completed",
                    },
                    []
                ),
        });
        this.#runReconciliation = new OpenClawChatRunReconciliation({
            clearSettledRequestBoundariesWithinRun: (sessionKey, firstSequence) =>
                this.#requestLifecycle.clearSettledRequestBoundariesWithinRun(
                    sessionKey,
                    firstSequence
                ),
            compactionSettlements: this.#compactionSettlements,
            enforceReplayMemoryLimit: (protectedSessionKey) =>
                this.#replaySessions.enforceReplayMemoryLimit(protectedSessionKey),
            flushSession: (sessionKey) => this.#persistence.flushSession(sessionKey),
            identity: this.#identity,
            promoteSessionEntry: (
                sourceSessionKey,
                canonicalSessionKey,
                preferredRunId
            ) =>
                this.#replaySessions.promoteSessionEntry(
                    sourceSessionKey,
                    canonicalSessionKey,
                    preferredRunId
                ),
            requestBoundaries: this.#requestBoundaries,
            runsBySession: this.#runsBySession,
        });
        this.#replayRetention = new OpenClawChatReplayRetention({
            clearSettledRequestBoundariesWithinRun: (sessionKey, firstSequence) =>
                this.#requestLifecycle.clearSettledRequestBoundariesWithinRun(
                    sessionKey,
                    firstSequence
                ),
            compactionSettlements: this.#compactionSettlements,
            enforceReplayMemoryLimit: (protectedSessionKey) =>
                this.#replaySessions.enforceReplayMemoryLimit(protectedSessionKey),
            enforceSessionLimit: (protectedSessionKey) =>
                this.#replaySessions.enforceSessionLimit(protectedSessionKey),
            identity: this.#identity,
            persistence: this.#persistence,
            pruneStaleActiveRuns: (sessionKey) =>
                this.#replaySessions.pruneStaleActiveRuns(sessionKey),
            refreshTotalReplayBytes: () => this.#replaySessions.refreshTotalReplayBytes(),
            requestBoundaries: this.#requestBoundaries,
            runReconciliation: this.#runReconciliation,
            runsBySession: this.#runsBySession,
        });
        this.#replaySessions = new OpenClawChatReplaySessions({
            advanceSequence: (sequence) => {
                this.#sequence = Math.max(this.#sequence, sequence);
            },
            compactionSettlements: this.#compactionSettlements,
            currentSequence: () => this.#sequence,
            identity: this.#identity,
            maxReplayBytes,
            metrics: this.#metrics,
            now: this.#now,
            persistence: this.#persistence,
            requestBoundaries: this.#requestBoundaries,
            retain: (envelope, shouldPersist) =>
                this.#replayRetention.retain(envelope, shouldPersist),
            runReconciliation: this.#runReconciliation,
            runsBySession: this.#runsBySession,
        });
        this.#requestLifecycle = new OpenClawChatRequestLifecycle({
            currentSequence: () => this.#sequence,
            identity: this.#identity,
            persistence: this.#persistence,
            replaySessions: this.#replaySessions,
            requestBoundaries: this.#requestBoundaries,
            requireSequenceHydrated: () => this.#requireSequenceHydrated(),
            runReconciliation: this.#runReconciliation,
            runsBySession: this.#runsBySession,
            runtimeIdentityEnvelope: (sessionKey, repaired) =>
                this.#runtimeIdentityEnvelope(sessionKey, repaired),
        });
        if (!store) {
            this.#sequenceHydrated = true;
            return;
        }
        this.#tryHydrateSequence();
    }

    #tryHydrateSequence(): boolean {
        if (this.#sequenceHydrated) {
            return true;
        }
        const maximumSequence = this.#persistence.maximumSequence();
        if (maximumSequence === undefined) {
            return false;
        }
        this.#sequence = maximumSequence;
        this.#sequenceHydrated = true;
        return true;
    }

    #requireSequenceHydrated(): void {
        if (!this.#tryHydrateSequence()) {
            throw new Error("Runtime snapshot sequence watermark is unavailable");
        }
    }

    #enrichPayload(
        event: unknown,
        payload: unknown,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): unknown {
        if (typeof event !== "string" || !RETAINED_RUNTIME_EVENTS.has(event)) {
            return payload;
        }

        const record = asRecord(payload);
        if (!record) {
            return payload;
        }

        const payloadView = runtimePayloadView(record) || record;

        this.reconcileSessions(sessions);

        const runId =
            stringField(payloadView, "runId") ||
            this.#retainedSessionMessageRunId(event, payloadView);
        const providedSessionKey = stringField(payloadView, "sessionKey");
        if (providedSessionKey) {
            const candidates = this.#identity.sessionCandidates(
                providedSessionKey,
                runId,
                sessions
            );
            if (candidates.size === 1) {
                const canonical = candidates.values().next().value;
                return withRuntimeIdentity(record, {
                    runId,
                    sessionKey: canonical || providedSessionKey,
                });
            }
            if (candidates.size > 1 && !isAgentSessionKey(providedSessionKey)) {
                return withRuntimeIdentity(record, {
                    runId,
                    shouldRemoveSessionKey: true,
                });
            }
            return withRuntimeIdentity(record, {
                runId,
                sessionKey: providedSessionKey,
            });
        }

        if (!runId) {
            return payload;
        }

        const sessionKey = this.#identity.sessionKeyForRun(runId, sessions);

        return withRuntimeIdentity(record, { runId, sessionKey });
    }

    #retainedSessionMessageRunId(
        event: unknown,
        payload: Record<string, unknown>
    ): string | undefined {
        const inferredRunId = sessionMessageRunId(event, payload);
        if (inferredRunId && !isProvisionalRunId(inferredRunId)) {
            return inferredRunId;
        }
        const sessionKey = stringField(payload, "sessionKey");
        const provisionalActiveRunIds = sessionMessageActiveRunIds(payload).filter(
            (runId) => isProvisionalRunId(runId)
        );
        if (!sessionKey || provisionalActiveRunIds.length !== 1) {
            return inferredRunId;
        }
        const activeRunId = provisionalActiveRunIds[0]!;
        for (const [candidateSessionKey, runs] of this.#runsBySession) {
            const run = runs.get(activeRunId);
            if (
                run &&
                !run.completed &&
                isSameSessionKey(candidateSessionKey, sessionKey)
            ) {
                return activeRunId;
            }
        }
        return inferredRunId;
    }

    #runtimeIdentityEnvelope(
        sessionKey: string,
        repaired: RepairedInterruptedRun
    ): OpenClawRuntimeEnvelope {
        return boundedCanonicalRuntimeEnvelope(
            withCanonicalOpenClawEvents({
                event: "chat.runtimeIdentity",
                payload: {
                    runId: repaired.providerRunId,
                    sessionKey,
                },
                runtimeRecordedAt: this.#now(),
                runtimeRunAliases: repaired.interruptedRunIds,
                // Identity controls are live events too. They must advance the
                // sequence so a reconnect snapshot containing the provider event
                // that triggered the repair cannot deduplicate this alias rewrite.
                runtimeSequence: ++this.#sequence,
                type: "event",
            })
        );
    }

    #dropMemoryState(): void {
        this.#compactionSettlements.clear();
        this.#replaySessions.clearMemory();
        this.#identity.clear();
        this.#requestBoundaries.clear();
        this.#persistence.clearMemoryIndexes();
    }

    /**
     * Returns content-free replay and persistence metrics.
     * @returns Current chat runtime metrics.
     */
    getMetrics(): ChatRuntimeMetrics {
        let events = 0;
        let runs = 0;
        for (const sessionRuns of this.#runsBySession.values()) {
            runs += sessionRuns.size;
            for (const run of sessionRuns.values()) {
                events += run.events.length;
            }
        }
        return this.#metrics.snapshot({
            currentBytes: this.#replaySessions.currentReplayBytes,
            events,
            maxBytes: this.#replaySessions.maxReplayBytes,
            runs,
            sessions: this.#runsBySession.size,
        });
    }

    /**
     * Flushes all coalesced replay writes at lifecycle boundaries.
     * @returns Whether every replay write was flushed successfully.
     */
    flush(): boolean {
        return this.#persistence.flush();
    }

    /**
     * Drops only process-local indexes while retaining the persisted replay.
     * @returns Whether process-local indexes were cleared successfully.
     */
    clearMemory(): boolean {
        if (!this.flush()) {
            return false;
        }
        this.#dropMemoryState();
        return true;
    }

    /** Restores persisted run associations before a Gateway scope resumes events. */
    hydratePersistedSessions(): void {
        this.#replaySessions.hydratePersistedSessions();
    }

    /**
     * Allows one interrupted conversation to resume under a fresh provider run ID.
     * @param disconnectedAt Disconnected at timestamp.
     */
    markGatewayDisconnected(disconnectedAt = this.#now()): void {
        this.#compactionSettlements.disconnect();
        for (const [sessionKey, runs] of this.#runsBySession) {
            const interruptedRuns = runs
                .values()
                .filter(
                    (candidate) => !candidate.completed && !isCompactionOnlyRun(candidate)
                )
                .toArray();
            for (const run of interruptedRuns) {
                run.interruptionEligible = true;
                run.interruptedAt = disconnectedAt;
                this.#compactionSettlements.clearTimer(sessionKey, run.runId);
            }
            if (interruptedRuns.length > 0) {
                this.#persistence.queueSession(sessionKey);
            }
        }
    }

    /** Resumes deferred settlement clocks once Gateway recovery can receive events. */
    markGatewayConnected(): void {
        if (!this.#compactionSettlements.connect()) {
            return;
        }
        for (const sessionKey of this.#runsBySession.keys()) {
            this.#compactionSettlements.rescheduleForSession(
                sessionKey,
                DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS
            );
        }
    }

    /** Clears all replay state, for example after credentials change. */
    clear(): void {
        this.#dropMemoryState();
        this.#persistence.clear();
    }

    /**
     * Canonicalizes quarantined short session keys after the session index loads.
     * @param sessions Sessions value.
     */
    reconcileSessions(sessions: readonly OpenClawChatSessionIdentity[]): void {
        for (const sessionKey of this.#runsBySession.keys()) {
            if (isAgentSessionKey(sessionKey)) {
                continue;
            }
            const runs = this.#runsBySession.get(sessionKey);
            if (!runs) {
                continue;
            }
            for (const runId of runs.keys()) {
                const candidates = this.#identity.sessionCandidates(
                    sessionKey,
                    runId,
                    sessions
                );
                if (candidates.size === 1) {
                    const canonical = candidates.values().next().value;
                    if (canonical && canonical !== sessionKey) {
                        this.#replaySessions.promoteSessionEntry(
                            sessionKey,
                            canonical,
                            runId
                        );
                    }
                }
            }
        }
    }

    /**
     * Hydrates the target before durably capturing one outgoing chat request.
     * @param sessionKey Session key value.
     * @param requestId Request identifier.
     * @returns Captured request-boundary sequence number.
     */
    captureRequestBoundary(sessionKey?: string, requestId?: string): number {
        return this.#requestLifecycle.captureRequestBoundary(sessionKey, requestId);
    }

    /**
     * Clears replay state associated with one reset, aborted, or deleted session.
     * @param sessionKey Session key value.
     */
    clearSession(sessionKey: string): void {
        this.#requestLifecycle.clearSession(sessionKey);
    }

    /**
     * Updates run associations and replay cleanup after successful RPCs.
     * @param method Method value.
     * @param parameters Parameters value.
     * @param payload Request or event payload.
     * @param requestBoundary Request boundary value.
     * @returns Updated runtime envelope when a successful send changes replay state.
     */
    handleSuccessfulRequest(
        method: string,
        parameters: Record<string, unknown>,
        payload: unknown,
        requestBoundary?: number
    ): OpenClawRuntimeEnvelope | undefined {
        return this.#requestLifecycle.handleSuccessfulRequest(
            method,
            parameters,
            payload,
            requestBoundary
        );
    }

    /**
     * Removes a request boundary when the Gateway rejects or times out a send.
     * @param method Method value.
     * @param parameters Parameters value.
     * @param requestBoundary Request boundary value.
     */
    handleFailedRequest(
        method: string,
        parameters: Record<string, unknown>,
        requestBoundary?: number
    ): void {
        this.#requestLifecycle.handleFailedRequest(method, parameters, requestBoundary);
    }

    /**
     * Records one Gateway event and returns the exact sequenced envelope to
     * broadcast. Events without a session remain live-only and are not cached.
     * @param event Event to handle.
     * @param payload Request or event payload.
     * @param sessions Sessions value.
     * @returns Exact sequenced runtime event envelope.
     */
    recordEvent(
        event: unknown,
        payload: unknown,
        sessions: readonly OpenClawChatSessionIdentity[]
    ): OpenClawRuntimeEnvelope {
        this.#requireSequenceHydrated();
        const providedSessionKey = stringField(runtimePayloadView(payload), "sessionKey");
        if (providedSessionKey) {
            this.#replaySessions.ensureSessionLoaded(providedSessionKey);
        }
        const enrichedPayload = this.#enrichPayload(event, payload, sessions);
        const enrichedSessionKey = stringField(asRecord(enrichedPayload), "sessionKey");
        if (enrichedSessionKey && enrichedSessionKey !== providedSessionKey) {
            this.#replaySessions.ensureSessionLoaded(enrichedSessionKey);
        }
        const envelope = boundedCanonicalRuntimeEnvelope(
            withCanonicalOpenClawEvents({
                type: "event",
                event,
                payload: enrichedPayload,
                runtimeRecordedAt: this.#now(),
                runtimeSequence: ++this.#sequence,
            })
        );
        const requestRepair = this.#requestLifecycle.settleRequestEvent(
            event,
            enrichedPayload
        );
        const runtimeRunAliases = [
            ...(requestRepair?.interruptedRunIds || []),
            ...this.#replayRetention.retain(
                envelope,
                true,
                runtimePayloadView(enrichedPayload)
            ),
        ].filter((runId, index, aliases) => aliases.indexOf(runId) === index);
        return runtimeRunAliases.length > 0
            ? boundedCanonicalRuntimeEnvelope(
                  withCurrentCanonicalOpenClawIdentity(
                      withCanonicalOpenClawEvents({
                          ...envelope,
                          runtimeRunAliases,
                      })
                  )
              )
            : envelope;
    }

    /**
     * Returns active runs or the latest completed run for one session.
     * @param sessionKey Session key value.
     * @returns active runs or the latest completed run for one session.
     */
    snapshot(sessionKey: string): OpenClawRuntimeSnapshot {
        return this.#replaySessions.snapshot(sessionKey);
    }
}
