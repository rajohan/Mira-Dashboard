import {
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "../../../contracts/chat.ts";
import {
    withCanonicalOpenClawEvents,
    withCurrentCanonicalOpenClawIdentity,
} from "../../../contracts/chat/openClawRuntimeAdapter.ts";
import type { ChatRuntimeMetrics } from "../../../contracts/metrics.ts";
import {
    isActiveConversationAtBoundary,
    isAgentSessionKey,
    isExactSessionKey,
    isMatchingSessionEcho,
    isPromotableRunlessUserLedRun,
    isProvisionalRunId,
    isRunlessRunId,
    isSameSessionKey,
    INTERRUPTED_RUN_PROMOTION_WINDOW_MS,
    latestOptionalTimestamp,
    normalizedSessionKey,
    OpenClawChatIdentityRegistry,
    promotableInterruptedConversationRuns,
    sessionMessageRequestId,
    sessionMessageRunId,
    type OpenClawChatSessionIdentity,
    type RepairedInterruptedRun,
} from "./openClawChatIdentity.ts";
import {
    isCompactionEvent,
    isConversationContinuationEvent,
    isMetadataOnlyCompletionEnvelope,
    isSettlingLifecycleEvent,
    isSuccessfulLifecycleSettlementEvent,
    isTerminalEvent,
    runtimeSessionBoundary,
} from "./openClawChatLifecycle.ts";
import { OpenClawChatRuntimeMetricsRecorder } from "./openClawChatMetrics.ts";
import {
    MAX_CHAT_RUNTIME_SESSIONS,
    OpenClawChatPersistenceCoordinator,
    type OpenClawChatSnapshotStore,
} from "./openClawChatPersistence.ts";
import {
    asRecord,
    compactTerminalPayload,
    runtimePayloadView,
    runtimeSessionId,
    sessionMessageActiveRunIds,
    stringField,
    withRuntimeIdentity,
} from "./openClawChatProviderAdapter.ts";
import {
    OpenClawChatRequestBoundaries,
    type OpenClawChatRequestBoundaryMetadata,
} from "./openClawChatRequestBoundaries.ts";
import {
    ACTIVE_RUN_TTL_MS,
    boundedCanonicalRuntimeEnvelope,
    coalesceReplayEnvelope,
    compactCompletedRun,
    firstSequence,
    hasActiveConversationRun,
    hasChatFinal,
    isAuxiliaryOnlyCompletion,
    isCompactionOnlyRun,
    isMetadataOnlyRunlessCompletion,
    lastSequence,
    MAX_BYTES_ACROSS_REPLAY,
    MAX_BYTES_PER_EVENT,
    MAX_RUNS_PER_SESSION,
    oldestEvictableSessionKey,
    oldestReplayBudgetSessionKey,
    replayBytes,
    replayCoalescingKey,
    RETAINED_RUNTIME_EVENTS,
    shouldRetainRuntimeEvent,
    snapshotFromRetainedRuns,
    trimRetainedRun,
    type RetainedRun,
} from "./openClawChatRetention.ts";

interface OpenClawChatBridgeOptions {
    maxReplayBytes?: number;
    nestedCompactionSettlementGraceMs?: number;
    now?: () => number;
    onDeferredEnvelope?: (envelope: OpenClawRuntimeEnvelope) => void;
}

const NESTED_COMPACTION_SETTLEMENT_GRACE_MS = 60_000;
const DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS = 1000;
const DEFERRED_COMPACTION_CONTINUATION_MARKER = "nested-compaction-continuation";
type UnrefableTimer = ReturnType<typeof setTimeout> & { unref?: () => void };

/**
 * Coordinates canonical provider, lifecycle, identity, retention, request
 * boundary, and persistence seams for live Gateway chat runtime replay.
 */
export class OpenClawChatBridge {
    readonly #identity = new OpenClawChatIdentityRegistry();
    readonly #metrics = new OpenClawChatRuntimeMetricsRecorder();
    readonly #persistence: OpenClawChatPersistenceCoordinator;
    readonly #runsBySession = new Map<string, Map<string, RetainedRun>>();
    readonly #requestBoundaries = new OpenClawChatRequestBoundaries(
        normalizedSessionKey,
        isSameSessionKey
    );
    readonly #deferredCompactionTimers = new Map<string, ReturnType<typeof setTimeout>>();
    readonly #maxReplayBytes: number;
    readonly #nestedCompactionSettlementGraceMs: number;
    readonly #now: () => number;
    readonly #onDeferredEnvelope?: (envelope: OpenClawRuntimeEnvelope) => void;
    #enforcingReplayMemoryLimit = false;
    #replayMemoryLimitDeferrals = 0;
    #sequence = 0;
    #sequenceHydrated = false;
    #sessionLimitDeferrals = 0;
    #totalReplayBytes = 0;

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
        this.#maxReplayBytes = maxReplayBytes;
        this.#nestedCompactionSettlementGraceMs = nestedCompactionSettlementGraceMs;
        this.#now = options.now ?? (() => Date.now());
        this.#onDeferredEnvelope = options.onDeferredEnvelope;
        this.#persistence = new OpenClawChatPersistenceCoordinator(store, {
            ensureSessionLoaded: (sessionKey) => this.#ensureSessionLoaded(sessionKey),
            metrics: this.#metrics,
            snapshotFromMemory: (sessionKey) =>
                this.#snapshotFromMemory(sessionKey, true),
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

    #withDeferredSessionLimit<T>(operation: () => T): T {
        this.#sessionLimitDeferrals += 1;
        try {
            return operation();
        } finally {
            this.#sessionLimitDeferrals -= 1;
        }
    }

    #ensureSessionLoaded(sessionKey: string): boolean {
        if (!this.#persistence.enabled) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        if (!this.#persistence.prepareSession(storageSessionKey)) {
            return false;
        }
        if (this.#persistence.isHydratedLookup(storageSessionKey)) {
            return true;
        }
        const storedKeys = this.#persistence.storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const exactKey = storedKeys.find((candidate) =>
            isExactSessionKey(candidate, storageSessionKey)
        );
        const matchingKeys = exactKey
            ? [exactKey]
            : storedKeys.filter((candidate) =>
                  isSameSessionKey(candidate, storageSessionKey)
              );
        if (matchingKeys.length === 0) {
            this.#persistence.markHydratedLookup(storageSessionKey);
            return true;
        }
        if (matchingKeys.length !== 1) {
            return false;
        }
        const storedKey = matchingKeys[0]!;
        const storedStorageKey = normalizedSessionKey(storedKey);
        if (this.#persistence.hasPendingDelete(storedKey)) {
            return (
                this.#persistence.prepareSession(storedKey) &&
                this.#ensureSessionLoaded(sessionKey)
            );
        }
        this.#persistence.markHydratedLookup(storageSessionKey);
        if (this.#persistence.isLoaded(storedStorageKey)) {
            const requiresCanonicalPromotion =
                storedStorageKey !== storageSessionKey &&
                isAgentSessionKey(storageSessionKey);
            if (
                requiresCanonicalPromotion &&
                !this.#promoteSessionEntry(
                    storedStorageKey,
                    storageSessionKey,
                    undefined,
                    storageSessionKey
                )
            ) {
                this.#persistence.forgetHydratedLookup(storageSessionKey);
                return false;
            }
            return true;
        }
        const loadResult = this.#persistence.load(storedKey);
        if (!loadResult.ok) {
            this.#persistence.forgetHydratedLookup(storageSessionKey);
            return false;
        }
        const { snapshot } = loadResult;
        if (!snapshot) {
            return true;
        }
        this.#sequence = Math.max(this.#sequence, snapshot.throughSequence);
        this.#requestBoundaries.restore(storedStorageKey, snapshot);
        const sortedEvents = snapshot.events.toSorted(
            (left, right) => left.runtimeSequence - right.runtimeSequence
        );
        this.#withDeferredSessionLimit(() => {
            for (const envelope of sortedEvents) {
                this.#sequence = Math.max(this.#sequence, envelope.runtimeSequence);
                this.#retain(envelope, false);
            }
        });
        const hydratedRuns = this.#runsBySession.get(storedStorageKey);
        const firstSequenceEntries = Object.entries(snapshot.firstSequenceByRun || {});
        for (const [runId, firstSequenceValue] of firstSequenceEntries) {
            const hydratedRun = hydratedRuns?.get(runId);
            if (hydratedRun) {
                hydratedRun.firstSequence = Math.min(
                    hydratedRun.firstSequence,
                    firstSequenceValue
                );
            }
        }
        const interruptedRunEntries = Object.entries(snapshot.interruptedAtByRun || {});
        for (const [runId, interruptedAt] of interruptedRunEntries) {
            const hydratedRun = hydratedRuns?.get(runId);
            if (!hydratedRun) {
                continue;
            }
            hydratedRun.interruptionEligible = true;
            hydratedRun.interruptedAt = interruptedAt;
            this.#clearDeferredCompactionTimer(storedStorageKey, runId);
        }
        const repairedRunIdentity = hydratedRuns
            ? this.#repairInterruptedRunSplit(storedStorageKey, hydratedRuns)
            : undefined;
        if (repairedRunIdentity) {
            for (const interruptedRunId of repairedRunIdentity.interruptedRunIds) {
                this.#identity.forgetRunSession(interruptedRunId, storedStorageKey);
            }
            this.#identity.rememberRunSession(
                repairedRunIdentity.providerRunId,
                storedStorageKey
            );
            this.#rescheduleDeferredCompactionTimersForSession(storedStorageKey);
        }
        const prunedStaleRun = this.#pruneStaleActiveRuns(storedStorageKey);
        if (prunedStaleRun && !this.#runsBySession.has(storedStorageKey)) {
            const didPersist = this.#persistence.flushSession(storedStorageKey);
            if (!didPersist) {
                this.#persistence.forgetHydratedLookup(storageSessionKey);
            }
            this.#enforceSessionLimit(storageSessionKey);
            return didPersist;
        }
        if (
            storedStorageKey !== storageSessionKey &&
            isAgentSessionKey(storageSessionKey)
        ) {
            if (
                !this.#promoteSessionEntry(
                    storedStorageKey,
                    storageSessionKey,
                    undefined,
                    storageSessionKey
                )
            ) {
                this.#persistence.forgetHydratedLookup(storageSessionKey);
                this.#enforceSessionLimit(storedStorageKey);
                return false;
            }
            return true;
        }
        this.#enforceSessionLimit(storedStorageKey);
        if (
            (prunedStaleRun || repairedRunIdentity) &&
            !this.#persistence.flushSession(storedStorageKey)
        ) {
            this.#persistence.forgetHydratedLookup(storageSessionKey);
            return false;
        }
        return true;
    }

    #ensureEquivalentSessionsLoaded(sessionKey: string): boolean {
        if (!this.#ensureSessionLoaded(sessionKey)) {
            return false;
        }
        const storedKeys = this.#persistence.storedSessionKeys();
        return Boolean(
            storedKeys?.every(
                (candidateSessionKey) =>
                    !isSameSessionKey(candidateSessionKey, sessionKey) ||
                    this.#ensureSessionLoaded(candidateSessionKey)
            )
        );
    }

    #deferredCompactionTimerKey(sessionKey: string, runId: string): string {
        return `${normalizedSessionKey(sessionKey)}\u0000${runId}`;
    }

    #clearDeferredCompactionTimer(sessionKey: string, runId: string): void {
        const key = this.#deferredCompactionTimerKey(sessionKey, runId);
        const timer = this.#deferredCompactionTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.#deferredCompactionTimers.delete(key);
        }
    }

    #clearDeferredCompactionTimersForSession(sessionKey: string): void {
        const prefix = `${normalizedSessionKey(sessionKey)}\u0000`;
        for (const [key, timer] of this.#deferredCompactionTimers) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            clearTimeout(timer);
            this.#deferredCompactionTimers.delete(key);
        }
    }

    #rescheduleDeferredCompactionTimersForSession(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        this.#clearDeferredCompactionTimersForSession(storageSessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return;
        }
        for (const run of runs.values()) {
            if (run.pendingCompactionSettlementAt !== undefined && !run.completed) {
                this.#scheduleDeferredCompactionSettlement(storageSessionKey, run);
            }
        }
    }

    #mergeDeferredCompactionSettlementState(
        target: RetainedRun,
        source: RetainedRun
    ): void {
        if (target.completed || source.completed) {
            target.pendingCompactionSettlementAt = undefined;
            target.pendingCompactionSettlementSequence = undefined;
            return;
        }
        const targetLastSequence = lastSequence(target);
        const sourceLastSequence = lastSequence(source);
        const sourceIsNewer =
            sourceLastSequence > targetLastSequence ||
            (sourceLastSequence === targetLastSequence &&
                source.updatedAt > target.updatedAt);
        if (sourceIsNewer) {
            target.pendingCompactionSettlementAt = source.pendingCompactionSettlementAt;
            target.pendingCompactionSettlementSequence =
                source.pendingCompactionSettlementSequence;
        }
    }

    #clearDeferredCompactionSettlementOnContinuation(
        sessionKey: string,
        envelope: OpenClawRuntimeEnvelope,
        shouldPersist: boolean
    ): RetainedRun | undefined {
        if (
            isTerminalEvent(envelope.event, envelope.payload) ||
            !isConversationContinuationEvent(envelope.event, envelope.payload)
        ) {
            return undefined;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return undefined;
        }
        const explicitRunId = stringField(runtimePayloadView(envelope.payload), "runId");
        const activeConversationRuns = runs
            .values()
            .filter((run) => !run.completed && !isCompactionOnlyRun(run))
            .toArray();
        let run = explicitRunId ? runs.get(explicitRunId) : undefined;
        if (explicitRunId && !run) {
            const interruptedRuns = promotableInterruptedConversationRuns(
                envelope,
                runs,
                this.#requestBoundaries.blocking(storageSessionKey)
            );
            if (interruptedRuns.length === 1) {
                run = interruptedRuns[0];
            }
        }
        if (!explicitRunId && activeConversationRuns.length === 1) {
            run = activeConversationRuns[0];
        }
        if (
            !run ||
            run.pendingCompactionSettlementSequence === undefined ||
            envelope.runtimeSequence <= run.pendingCompactionSettlementSequence
        ) {
            return undefined;
        }
        run.pendingCompactionSettlementAt = undefined;
        run.pendingCompactionSettlementSequence = undefined;
        run.updatedAt = Math.max(run.updatedAt, envelope.runtimeRecordedAt);
        this.#clearDeferredCompactionTimer(storageSessionKey, run.runId);
        if (shouldPersist) {
            this.#persistence.queueSession(storageSessionKey);
        }
        return run;
    }

    #scheduleDeferredCompactionSettlement(
        sessionKey: string,
        run: RetainedRun,
        minimumDelayMs = 0
    ): void {
        const pendingAt = run.pendingCompactionSettlementAt;
        if (pendingAt === undefined || run.completed || run.interruptionEligible) {
            this.#clearDeferredCompactionTimer(sessionKey, run.runId);
            return;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const key = this.#deferredCompactionTimerKey(storageSessionKey, run.runId);
        this.#clearDeferredCompactionTimer(storageSessionKey, run.runId);
        const delayMs = Math.max(
            minimumDelayMs,
            pendingAt + this.#nestedCompactionSettlementGraceMs - this.#now()
        );
        const timer = setTimeout(() => {
            this.#deferredCompactionTimers.delete(key);
            const didComplete = this.#completeExpiredCompactionSettlements(
                storageSessionKey,
                this.#now()
            );
            if (didComplete) {
                return;
            }
            const pendingRun = this.#runsBySession.get(storageSessionKey)?.get(run.runId);
            if (pendingRun?.pendingCompactionSettlementAt !== undefined) {
                this.#scheduleDeferredCompactionSettlement(
                    storageSessionKey,
                    pendingRun,
                    DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS
                );
            }
        }, delayMs);
        (timer as UnrefableTimer).unref?.();
        this.#deferredCompactionTimers.set(key, timer);
    }

    #completeExpiredCompactionSettlements(
        sessionKey: string,
        now = this.#now()
    ): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return false;
        }
        let didComplete = false;
        const runsSnapshot = runs.values().toArray();
        for (const run of runsSnapshot) {
            const pendingAt = run.pendingCompactionSettlementAt;
            if (
                run.completed ||
                run.interruptionEligible ||
                pendingAt === undefined ||
                now - pendingAt < this.#nestedCompactionSettlementGraceMs
            ) {
                continue;
            }
            this.#clearDeferredCompactionTimer(storageSessionKey, run.runId);
            try {
                const envelope = this.recordEvent(
                    "model.completed",
                    {
                        completionReason: "nested-compaction-settlement-timeout",
                        runId: run.runId,
                        sessionKey: storageSessionKey,
                        status: "completed",
                    },
                    []
                );
                didComplete = true;
                try {
                    this.#onDeferredEnvelope?.(envelope);
                } catch {
                    // The retained completion remains durable if a live subscriber fails.
                }
            } catch {
                this.#scheduleDeferredCompactionSettlement(
                    storageSessionKey,
                    run,
                    DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS
                );
            }
        }
        return didComplete;
    }

    #pruneStaleActiveRuns(sessionKey: string, now = this.#now()): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return false;
        }
        let hasChanged = false;
        for (const [runId, run] of runs) {
            // Completed replay is the durable "last run" view and is intentionally
            // retained until a successful new send replaces it. The TTL only
            // recovers abandoned active runs after a missing lifecycle end.
            const latestActivityAt = Math.max(
                run.updatedAt,
                run.interruptedAt ?? -Infinity
            );
            if (run.completed || now - latestActivityAt <= ACTIVE_RUN_TTL_MS) {
                continue;
            }
            this.#clearDeferredCompactionTimer(storageSessionKey, runId);
            runs.delete(runId);
            this.#identity.forgetRunSession(runId, sessionKey);
            hasChanged = true;
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(storageSessionKey);
        }
        if (hasChanged) {
            this.#refreshTotalReplayBytes();
        }
        return hasChanged;
    }

    #snapshotFromRuns(
        runs: ReadonlyMap<string, RetainedRun> | undefined,
        shouldIncludePersistenceMetadata = false,
        requestBoundaries: OpenClawChatRequestBoundaryMetadata = {}
    ): OpenClawRuntimeSnapshot {
        return snapshotFromRetainedRuns(
            runs,
            this.#sequence,
            shouldIncludePersistenceMetadata,
            requestBoundaries
        );
    }

    #snapshotFromMemory(
        sessionKey: string,
        shouldIncludePersistenceMetadata = false
    ): OpenClawRuntimeSnapshot {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        return this.#snapshotFromRuns(
            this.#runsBySession.get(storageSessionKey),
            shouldIncludePersistenceMetadata,
            shouldIncludePersistenceMetadata
                ? this.#requestBoundaries.metadata(storageSessionKey)
                : {}
        );
    }

    #evictSessionFromMemory(sessionKey: string, reason?: "memory" | "session"): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const evictedBytes = replayBytes(
            this.#runsBySession.get(storageSessionKey)?.values() || []
        );
        this.#persistence.cancelPendingSession(storageSessionKey);
        this.#clearDeferredCompactionTimersForSession(storageSessionKey);
        this.#runsBySession.delete(storageSessionKey);
        this.#requestBoundaries.forgetExact(storageSessionKey);
        this.#totalReplayBytes = Math.max(0, this.#totalReplayBytes - evictedBytes);
        this.#identity.forgetSession(storageSessionKey);
        this.#persistence.forgetMemorySession(storageSessionKey);
        if (reason) {
            this.#metrics.recordEviction(reason);
        }
    }

    #clearCompletedRuns(sessionKey: string, preservedRunId?: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#runsBySession.get(storageSessionKey);
        if (!runs) {
            return;
        }
        for (const [runId, run] of runs) {
            if (runId === preservedRunId || !run.completed) {
                continue;
            }
            this.#clearDeferredCompactionTimer(storageSessionKey, runId);
            runs.delete(runId);
            this.#identity.forgetRunSession(runId, storageSessionKey);
        }
        if (runs.size === 0) {
            this.#runsBySession.delete(storageSessionKey);
        }
        this.#refreshTotalReplayBytes();
        this.#persistence.flushSession(storageSessionKey);
    }

    #cloneRetainedRun(run: RetainedRun): RetainedRun {
        return {
            ...run,
            eventBytes: [...run.eventBytes],
            events: [...run.events],
        };
    }

    #ensureCanonicalDestinationLoaded(canonicalSessionKey: string): boolean {
        if (!this.#persistence.enabled) {
            return true;
        }
        const storageSessionKey = normalizedSessionKey(canonicalSessionKey);
        const storedKeys = this.#persistence.storedSessionKeys();
        if (!storedKeys) {
            return false;
        }
        const storedCanonicalKey = storedKeys.find((candidate) =>
            isExactSessionKey(candidate, storageSessionKey)
        );
        const storedCanonicalStorageKey = storedCanonicalKey
            ? normalizedSessionKey(storedCanonicalKey)
            : undefined;
        if (
            !storedCanonicalKey ||
            (storedCanonicalStorageKey &&
                this.#persistence.isLoaded(storedCanonicalStorageKey))
        ) {
            return true;
        }
        this.#withDeferredSessionLimit(() =>
            this.#ensureSessionLoaded(storedCanonicalKey)
        );
        return Boolean(
            storedCanonicalStorageKey &&
            this.#persistence.isLoaded(storedCanonicalStorageKey)
        );
    }

    #promoteSessionEntry(
        sourceSessionKey: string,
        canonicalSessionKey: string,
        preferredRunId?: string,
        protectedSessionKey?: string
    ): boolean {
        const sourceStorageKey = normalizedSessionKey(sourceSessionKey);
        const canonicalStorageKey = normalizedSessionKey(canonicalSessionKey);
        if (sourceStorageKey === canonicalStorageKey) {
            return true;
        }
        if (!this.#ensureCanonicalDestinationLoaded(canonicalStorageKey)) {
            return false;
        }
        const sourceRuns = this.#runsBySession.get(sourceStorageKey);
        if (!sourceRuns || (preferredRunId && !sourceRuns.has(preferredRunId))) {
            return false;
        }
        const previousCanonicalRuns = this.#runsBySession.get(canonicalStorageKey);
        const nextSourceRuns = new Map(
            [...sourceRuns].map(([runId, run]) => [runId, this.#cloneRetainedRun(run)])
        );
        const nextCanonicalRuns = new Map(
            [...(previousCanonicalRuns || [])].map(([runId, run]) => [
                runId,
                this.#cloneRetainedRun(run),
            ])
        );
        const movedRunIds = new Set<string>();
        const runIds = preferredRunId
            ? [preferredRunId]
            : nextSourceRuns.keys().toArray();
        for (const runId of runIds) {
            const sourceRun = nextSourceRuns.get(runId);
            if (!sourceRun) {
                continue;
            }
            const rewrittenEvents = sourceRun.events.flatMap((envelope) => {
                const payload = asRecord(envelope.payload);
                const payloadView = runtimePayloadView(payload);
                if (
                    !payload ||
                    !isExactSessionKey(
                        stringField(payloadView, "sessionKey") || "",
                        sourceStorageKey
                    )
                ) {
                    return [envelope];
                }
                const rewritten = boundedCanonicalRuntimeEnvelope(
                    withCurrentCanonicalOpenClawIdentity({
                        ...envelope,
                        payload: withRuntimeIdentity(payload, {
                            sessionKey: canonicalStorageKey,
                        }),
                    })
                );
                if (Buffer.byteLength(JSON.stringify(rewritten)) <= MAX_BYTES_PER_EVENT) {
                    return [rewritten];
                }
                if (!isTerminalEvent(envelope.event, rewritten.payload)) {
                    return [];
                }
                const rewrittenPayload = asRecord(rewritten.payload);
                const payloadRunId = stringField(payloadView, "runId");
                const compactPayload = compactTerminalPayload(
                    rewrittenPayload,
                    payloadRunId,
                    canonicalStorageKey
                );
                const compact = boundedCanonicalRuntimeEnvelope(
                    withCurrentCanonicalOpenClawIdentity({
                        ...envelope,
                        payload: compactPayload,
                    })
                );
                return Buffer.byteLength(JSON.stringify(compact)) <= MAX_BYTES_PER_EVENT
                    ? [compact]
                    : [];
            });
            this.#replaceRunEvents(sourceRun, rewrittenEvents);
            movedRunIds.add(runId);
            if (sourceRun.events.length === 0) {
                nextSourceRuns.delete(runId);
                continue;
            }
            const existing = nextCanonicalRuns.get(runId);
            if (existing) {
                this.#mergeDeferredCompactionSettlementState(existing, sourceRun);
                this.#replaceRunEvents(existing, [
                    ...existing.events,
                    ...sourceRun.events,
                ]);
                existing.completed ||= sourceRun.completed;
                existing.firstSequence = Math.min(
                    existing.firstSequence,
                    sourceRun.firstSequence
                );
                existing.interruptionEligible ||= sourceRun.interruptionEligible;
                existing.interruptedAt = latestOptionalTimestamp(
                    existing.interruptedAt,
                    sourceRun.interruptedAt
                );
                existing.terminalSequence = Math.max(
                    existing.terminalSequence,
                    sourceRun.terminalSequence
                );
                existing.updatedAt = Math.max(existing.updatedAt, sourceRun.updatedAt);
            } else {
                nextCanonicalRuns.set(runId, sourceRun);
            }
            nextSourceRuns.delete(runId);
        }

        const repairedRunIdentity =
            nextSourceRuns.size === 0
                ? this.#repairInterruptedRunSplit(canonicalStorageKey, nextCanonicalRuns)
                : undefined;

        const evictedCanonicalRunIds = new Set<string>();
        while (nextCanonicalRuns.size > MAX_RUNS_PER_SESSION) {
            const oldestRunId = nextCanonicalRuns
                .values()
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
            if (!oldestRunId) {
                break;
            }
            nextCanonicalRuns.delete(oldestRunId);
            evictedCanonicalRunIds.add(oldestRunId);
        }
        const requestBoundaries = this.#requestBoundaries.merge(
            sourceStorageKey,
            canonicalStorageKey
        );
        const sourceSnapshot = this.#snapshotFromRuns(
            nextSourceRuns,
            true,
            requestBoundaries
        );
        const canonicalSnapshot = this.#snapshotFromRuns(
            nextCanonicalRuns,
            true,
            requestBoundaries
        );
        if (
            !this.#persistence.promote(
                sourceStorageKey,
                canonicalStorageKey,
                sourceSnapshot,
                canonicalSnapshot
            )
        ) {
            return false;
        }
        if (nextCanonicalRuns.size === 0) {
            this.#runsBySession.delete(canonicalStorageKey);
        } else {
            this.#runsBySession.set(canonicalStorageKey, nextCanonicalRuns);
        }
        this.#persistence.cancelPendingSession(canonicalStorageKey);

        if (nextSourceRuns.size === 0) {
            this.#runsBySession.delete(sourceStorageKey);
        } else {
            this.#runsBySession.set(sourceStorageKey, nextSourceRuns);
        }
        this.#persistence.cancelPendingSession(sourceStorageKey);
        this.#requestBoundaries.forget(sourceStorageKey);
        this.#requestBoundaries.forget(canonicalStorageKey);
        if (nextSourceRuns.size > 0) {
            this.#requestBoundaries.restore(sourceStorageKey, requestBoundaries);
        }
        this.#requestBoundaries.restore(canonicalStorageKey, requestBoundaries);
        this.#identity.promoteRuntimeSession(
            sourceStorageKey,
            canonicalStorageKey,
            nextSourceRuns.size > 0
        );
        for (const runId of movedRunIds) {
            this.#identity.forgetRunSession(runId, sourceStorageKey);
            if (nextCanonicalRuns.has(runId)) {
                this.#identity.rememberRunSession(runId, canonicalStorageKey);
            }
        }
        if (repairedRunIdentity) {
            for (const interruptedRunId of repairedRunIdentity.interruptedRunIds) {
                this.#identity.forgetRunSession(interruptedRunId, canonicalStorageKey);
            }
            this.#identity.rememberRunSession(
                repairedRunIdentity.providerRunId,
                canonicalStorageKey
            );
        }
        for (const runId of evictedCanonicalRunIds) {
            this.#identity.forgetRunSession(runId, canonicalStorageKey);
        }
        this.#rescheduleDeferredCompactionTimersForSession(sourceStorageKey);
        this.#rescheduleDeferredCompactionTimersForSession(canonicalStorageKey);
        this.#enforceSessionLimit(protectedSessionKey);
        this.#enforceReplayMemoryLimit(protectedSessionKey || canonicalStorageKey);
        return true;
    }

    #refreshTotalReplayBytes(): void {
        let totalBytes = 0;
        for (const runs of this.#runsBySession.values()) {
            totalBytes += replayBytes(runs.values());
        }
        this.#totalReplayBytes = totalBytes;
        this.#metrics.observeReplayBytes(totalBytes);
    }

    #enforceReplayMemoryLimit(protectedSessionKey?: string): void {
        if (this.#enforcingReplayMemoryLimit || this.#replayMemoryLimitDeferrals > 0) {
            return;
        }
        const storageProtectedSessionKey = protectedSessionKey
            ? normalizedSessionKey(protectedSessionKey)
            : undefined;
        this.#enforcingReplayMemoryLimit = true;
        try {
            this.#refreshTotalReplayBytes();
            while (this.#totalReplayBytes > this.#maxReplayBytes) {
                const oldestSessionKey =
                    oldestReplayBudgetSessionKey(
                        this.#runsBySession,
                        isSameSessionKey,
                        storageProtectedSessionKey
                    ) ??
                    oldestReplayBudgetSessionKey(this.#runsBySession, isSameSessionKey);
                if (!oldestSessionKey) {
                    break;
                }
                // Keep the freshest persisted copy before releasing process memory.
                // The hard memory ceiling still wins if SQLite is temporarily failing.
                this.#persistence.flushSession(oldestSessionKey);
                this.#evictSessionFromMemory(oldestSessionKey, "memory");
            }
        } finally {
            this.#enforcingReplayMemoryLimit = false;
        }
    }

    #enforceSessionLimit(protectedSessionKey?: string): void {
        if (this.#sessionLimitDeferrals > 0) {
            return;
        }
        const storageProtectedSessionKey = protectedSessionKey
            ? normalizedSessionKey(protectedSessionKey)
            : undefined;
        while (this.#runsBySession.size > MAX_CHAT_RUNTIME_SESSIONS) {
            const oldestSessionKey = oldestEvictableSessionKey(
                this.#runsBySession,
                isSameSessionKey,
                storageProtectedSessionKey
            );
            if (!oldestSessionKey) {
                break;
            }
            this.#evictSessionFromMemory(oldestSessionKey, "session");
            this.#persistence.deleteSession(oldestSessionKey);
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

    #replaceRunEvents(run: RetainedRun, events: OpenClawRuntimeEnvelope[]): void {
        const uniqueEvents = new Map<number, OpenClawRuntimeEnvelope>();
        for (const event of events) {
            uniqueEvents.set(
                event.runtimeSequence,
                boundedCanonicalRuntimeEnvelope(
                    withCurrentCanonicalOpenClawIdentity(event)
                )
            );
        }
        run.events = uniqueEvents
            .values()
            .toArray()
            .toSorted((left, right) => left.runtimeSequence - right.runtimeSequence);
        run.eventBytes = run.events.map((event) =>
            Buffer.byteLength(JSON.stringify(event))
        );
        run.totalBytes = run.eventBytes.reduce((total, bytes) => total + bytes, 0);
        trimRetainedRun(run);
    }

    #rewriteProvisionalPayloads(
        sessionKey: string,
        run: RetainedRun,
        provisionalRunId: string,
        providerRunId: string
    ): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const events = run.events.flatMap((envelope) => {
            const payload = asRecord(envelope.payload);
            const payloadRunId = stringField(runtimePayloadView(payload), "runId");
            if (
                !payload ||
                (payloadRunId &&
                    payloadRunId !== provisionalRunId &&
                    !isProvisionalRunId(payloadRunId))
            ) {
                return [envelope];
            }

            const rewritten = boundedCanonicalRuntimeEnvelope(
                withCurrentCanonicalOpenClawIdentity({
                    ...envelope,
                    payload: withRuntimeIdentity(payload, { runId: providerRunId }),
                })
            );
            if (Buffer.byteLength(JSON.stringify(rewritten)) <= MAX_BYTES_PER_EVENT) {
                return [rewritten];
            }
            if (!isTerminalEvent(envelope.event, rewritten.payload)) {
                return [];
            }
            const compactPayload = compactTerminalPayload(
                asRecord(rewritten.payload),
                providerRunId,
                storageSessionKey
            );
            const compact = boundedCanonicalRuntimeEnvelope(
                withCurrentCanonicalOpenClawIdentity({
                    ...envelope,
                    payload: compactPayload,
                })
            );
            return Buffer.byteLength(JSON.stringify(compact)) <= MAX_BYTES_PER_EVENT
                ? [compact]
                : [];
        });
        this.#replaceRunEvents(run, events);
    }

    #mergeRunEntry(
        sessionKey: string,
        runs: Map<string, RetainedRun>,
        provisionalRunId: string,
        providerRunId: string
    ): RetainedRun | undefined {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const provisional = runs.get(provisionalRunId);
        if (!provisional || provisionalRunId === providerRunId) {
            return provisional;
        }

        this.#rewriteProvisionalPayloads(
            storageSessionKey,
            provisional,
            provisionalRunId,
            providerRunId
        );
        runs.delete(provisionalRunId);
        const existing = runs.get(providerRunId);
        if (existing) {
            this.#mergeDeferredCompactionSettlementState(existing, provisional);
            this.#replaceRunEvents(existing, [...provisional.events, ...existing.events]);
            existing.completed ||= provisional.completed;
            existing.firstSequence = Math.min(
                existing.firstSequence,
                provisional.firstSequence
            );
            existing.interruptionEligible = false;
            existing.interruptedAt = undefined;
            existing.terminalSequence = Math.max(
                existing.terminalSequence,
                provisional.terminalSequence
            );
            existing.updatedAt = Math.max(existing.updatedAt, provisional.updatedAt);
            return existing;
        }

        provisional.runId = providerRunId;
        provisional.interruptionEligible = false;
        provisional.interruptedAt = undefined;
        runs.set(providerRunId, provisional);
        return provisional;
    }

    #promoteRunEntry(
        sessionKey: string,
        runs: Map<string, RetainedRun>,
        provisionalRunId: string,
        providerRunId: string
    ): RetainedRun | undefined {
        const shouldForgetAssociation =
            provisionalRunId !== providerRunId && runs.has(provisionalRunId);
        const promotedRun = this.#mergeRunEntry(
            sessionKey,
            runs,
            provisionalRunId,
            providerRunId
        );
        if (shouldForgetAssociation && promotedRun) {
            this.#identity.forgetRunSession(provisionalRunId, sessionKey);
            this.#rescheduleDeferredCompactionTimersForSession(sessionKey);
        }
        return promotedRun;
    }

    #repairInterruptedRunSplit(
        sessionKey: string,
        runs: Map<string, RetainedRun>
    ): RepairedInterruptedRun | undefined {
        const candidate = this.#interruptedRunSplitCandidate(sessionKey, runs);
        if (!candidate) {
            return undefined;
        }
        let repairedRun = runs.get(candidate.providerRunId);
        if (!repairedRun) {
            return undefined;
        }
        this.#clearSettledRequestBoundariesWithinRun(
            sessionKey,
            firstSequence(repairedRun)
        );
        for (const interruptedRunId of candidate.interruptedRunIds) {
            repairedRun = this.#mergeRunEntry(
                sessionKey,
                runs,
                interruptedRunId,
                candidate.providerRunId
            );
        }
        return repairedRun
            ? {
                  interruptedRunIds: candidate.interruptedRunIds,
                  providerRunId: repairedRun.runId,
              }
            : undefined;
    }

    #interruptedRunSplitCandidate(
        sessionKey: string,
        runs: ReadonlyMap<string, RetainedRun>
    ): RepairedInterruptedRun | undefined {
        const candidates: RepairedInterruptedRun[] = [];
        const requestBoundary = this.#requestBoundaries.blocking(sessionKey);
        for (const providerRun of runs.values()) {
            if (isProvisionalRunId(providerRun.runId)) {
                continue;
            }
            const continuationEnvelope = providerRun.events.find((envelope) => {
                const envelopeRunId = stringField(
                    runtimePayloadView(envelope.payload),
                    "runId"
                );
                return (
                    envelopeRunId === providerRun.runId &&
                    isConversationContinuationEvent(envelope.event, envelope.payload)
                );
            });
            if (!continuationEnvelope) {
                continue;
            }
            const interruptedRuns = promotableInterruptedConversationRuns(
                continuationEnvelope,
                runs,
                requestBoundary,
                providerRun
            );
            if (interruptedRuns.length > 0) {
                candidates.push({
                    interruptedRunIds: interruptedRuns.map((run) => run.runId),
                    providerRunId: providerRun.runId,
                });
            }
        }
        if (candidates.length !== 1) {
            return undefined;
        }
        return candidates[0];
    }

    #repairInterruptedRunForSession(
        sessionKey: string
    ): RepairedInterruptedRun | undefined {
        const candidates = this.#runsBySession
            .entries()
            .filter(([candidateSessionKey]) =>
                isSameSessionKey(candidateSessionKey, sessionKey)
            )
            .flatMap(([candidateSessionKey, runs]) => {
                const candidate = this.#interruptedRunSplitCandidate(
                    candidateSessionKey,
                    runs
                );
                return candidate ? [{ candidate, sessionKey: candidateSessionKey }] : [];
            })
            .toArray();
        if (candidates.length !== 1) {
            return undefined;
        }
        const { sessionKey: candidateSessionKey } = candidates[0]!;
        const runs = this.#runsBySession.get(candidateSessionKey);
        if (!runs) {
            return undefined;
        }
        const repaired = this.#repairInterruptedRunSplit(candidateSessionKey, runs);
        if (!repaired) {
            return undefined;
        }
        for (const interruptedRunId of repaired.interruptedRunIds) {
            this.#identity.forgetRunSession(interruptedRunId, candidateSessionKey);
        }
        this.#identity.rememberRunSession(repaired.providerRunId, candidateSessionKey);
        this.#rescheduleDeferredCompactionTimersForSession(candidateSessionKey);
        this.#enforceReplayMemoryLimit(candidateSessionKey);
        this.#persistence.flushSession(candidateSessionKey);
        return repaired;
    }

    #acknowledgedProvisionalContinuationCandidate(
        runs: ReadonlyMap<string, RetainedRun>,
        provisionalRunId: string,
        requestId: string,
        requestBoundary: number
    ): RepairedInterruptedRun | undefined {
        if (provisionalRunId !== requestId || !isProvisionalRunId(provisionalRunId)) {
            return undefined;
        }
        const resumedRun = runs.get(provisionalRunId);
        if (
            !resumedRun ||
            resumedRun.completed ||
            isCompactionOnlyRun(resumedRun) ||
            firstSequence(resumedRun) <= requestBoundary
        ) {
            return undefined;
        }
        const continuationEnvelope = resumedRun.events.find((envelope) =>
            isConversationContinuationEvent(envelope.event, envelope.payload)
        );
        if (!continuationEnvelope) {
            return undefined;
        }
        const interruptedRuns = runs
            .values()
            .filter((run) => {
                const resumeDelay =
                    continuationEnvelope.runtimeRecordedAt -
                    (run.interruptedAt ?? run.updatedAt);
                return (
                    run !== resumedRun &&
                    !run.completed &&
                    !isCompactionOnlyRun(run) &&
                    run.interruptionEligible &&
                    firstSequence(run) <= requestBoundary &&
                    lastSequence(run) <= requestBoundary &&
                    resumeDelay >= -5000 &&
                    resumeDelay <= INTERRUPTED_RUN_PROMOTION_WINDOW_MS
                );
            })
            .toArray();
        if (
            interruptedRuns.length === 0 ||
            (interruptedRuns.length > 1 &&
                interruptedRuns.some((run) => run.interruptedAt === undefined))
        ) {
            return undefined;
        }
        const interruptedRunSet = new Set(interruptedRuns);
        const coversEveryActiveConversation = runs
            .values()
            .every(
                (run) =>
                    run === resumedRun ||
                    run.completed ||
                    isCompactionOnlyRun(run) ||
                    interruptedRunSet.has(run)
            );
        if (!coversEveryActiveConversation) {
            return undefined;
        }
        return {
            interruptedRunIds: interruptedRuns
                .toSorted(
                    (left, right) =>
                        firstSequence(left) - firstSequence(right) ||
                        left.runId.localeCompare(right.runId)
                )
                .map((run) => run.runId),
            providerRunId: provisionalRunId,
        };
    }

    #repairAcknowledgedProvisionalContinuationForSession(
        sessionKey: string,
        provisionalRunId: string | undefined,
        requestId: string | undefined,
        requestBoundary: number | undefined
    ): RepairedInterruptedRun | undefined {
        if (!provisionalRunId || !requestId || requestBoundary === undefined) {
            return undefined;
        }
        const candidates = this.#runsBySession
            .entries()
            .filter(([candidateSessionKey]) =>
                isSameSessionKey(candidateSessionKey, sessionKey)
            )
            .flatMap(([candidateSessionKey, runs]) => {
                const candidate = this.#acknowledgedProvisionalContinuationCandidate(
                    runs,
                    provisionalRunId,
                    requestId,
                    requestBoundary
                );
                return candidate ? [{ candidate, sessionKey: candidateSessionKey }] : [];
            })
            .toArray();
        if (candidates.length !== 1) {
            return undefined;
        }
        const { candidate, sessionKey: candidateSessionKey } = candidates[0]!;
        const runs = this.#runsBySession.get(candidateSessionKey);
        if (!runs) {
            return undefined;
        }
        let repairedRun = runs.get(candidate.providerRunId);
        if (!repairedRun) {
            return undefined;
        }
        for (const interruptedRunId of candidate.interruptedRunIds) {
            repairedRun = this.#mergeRunEntry(
                candidateSessionKey,
                runs,
                interruptedRunId,
                candidate.providerRunId
            );
            this.#identity.forgetRunSession(interruptedRunId, candidateSessionKey);
        }
        if (!repairedRun) {
            return undefined;
        }
        this.#identity.rememberRunSession(candidate.providerRunId, candidateSessionKey);
        this.#enforceReplayMemoryLimit(candidateSessionKey);
        this.#persistence.flushSession(candidateSessionKey);
        return candidate;
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

    #promoteProvisionalRun(
        sessionKey: string,
        providerRunId: string,
        preferredProvisionalRunId?: string,
        requestBoundary?: number
    ): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        let runs = this.#runsBySession.get(storageSessionKey);
        if (
            preferredProvisionalRunId &&
            !runs?.has(preferredProvisionalRunId) &&
            isAgentSessionKey(storageSessionKey)
        ) {
            const aliasEntries = [...this.#runsBySession].filter(
                ([candidateSessionKey, candidateRuns]) =>
                    !isAgentSessionKey(candidateSessionKey) &&
                    isSameSessionKey(candidateSessionKey, storageSessionKey) &&
                    candidateRuns.has(preferredProvisionalRunId)
            );
            if (aliasEntries.length === 1) {
                this.#promoteSessionEntry(
                    aliasEntries[0]![0],
                    storageSessionKey,
                    preferredProvisionalRunId
                );
                runs = this.#runsBySession.get(storageSessionKey);
            }
        }
        if (!runs) {
            return;
        }

        const preferred = preferredProvisionalRunId
            ? runs.get(preferredProvisionalRunId)
            : undefined;
        if (preferredProvisionalRunId && preferred) {
            this.#promoteRunEntry(
                storageSessionKey,
                runs,
                preferredProvisionalRunId,
                providerRunId
            );
            this.#enforceReplayMemoryLimit(storageSessionKey);
            this.#persistence.flushSession(storageSessionKey);
            return;
        }

        const provisionalEntries = runs
            .entries()
            .filter(([runId, run]) => {
                const isCurrentRequest =
                    requestBoundary === undefined || firstSequence(run) > requestBoundary;
                return (
                    runId !== providerRunId &&
                    isProvisionalRunId(run.runId) &&
                    isCurrentRequest &&
                    (!run.completed || isRunlessRunId(run.runId))
                );
            })
            .toArray();
        if (provisionalEntries.length !== 1) {
            return;
        }

        this.#promoteRunEntry(
            storageSessionKey,
            runs,
            provisionalEntries[0]![0],
            providerRunId
        );
        this.#enforceReplayMemoryLimit(storageSessionKey);
        this.#persistence.flushSession(storageSessionKey);
    }

    #retain(
        envelope: OpenClawRuntimeEnvelope,
        shouldPersist = true,
        retentionPayload?: Record<string, unknown>
    ): string[] {
        if (
            typeof envelope.event !== "string" ||
            !RETAINED_RUNTIME_EVENTS.has(envelope.event)
        ) {
            return [];
        }

        const payload = asRecord(envelope.payload);
        const payloadView = runtimePayloadView(payload);
        if (!payload || !payloadView) {
            return [];
        }
        const sessionKey = stringField(payloadView, "sessionKey");
        if (!sessionKey) {
            return [];
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);

        const incomingSessionId = runtimeSessionId(envelope.payload);
        const incomingSessionBoundary = runtimeSessionBoundary(envelope);
        const currentRuntimeSession = this.#identity.runtimeSession(storageSessionKey);
        let didReplaceRuntimeSession = false;
        if (
            incomingSessionId &&
            currentRuntimeSession &&
            incomingSessionId !== currentRuntimeSession.id
        ) {
            if (
                !incomingSessionBoundary ||
                incomingSessionBoundary.startedAt <= currentRuntimeSession.startedAt
            ) {
                return [];
            }
            const staleRuns = this.#runsBySession.get(storageSessionKey);
            const staleRunIds = staleRuns?.keys().toArray() || [];
            for (const runId of staleRunIds) {
                this.#identity.forgetRunSession(runId, storageSessionKey);
            }
            this.#clearDeferredCompactionTimersForSession(storageSessionKey);
            this.#runsBySession.delete(storageSessionKey);
            this.#requestBoundaries.forgetExact(storageSessionKey);
            this.#identity.setRuntimeSession(storageSessionKey, incomingSessionBoundary);
            this.#refreshTotalReplayBytes();
            didReplaceRuntimeSession = true;
        } else if (incomingSessionBoundary) {
            const nextRuntimeSession =
                currentRuntimeSession?.id === incomingSessionBoundary.id
                    ? {
                          ...currentRuntimeSession,
                          startedAt: Math.max(
                              currentRuntimeSession.startedAt,
                              incomingSessionBoundary.startedAt
                          ),
                      }
                    : incomingSessionBoundary;
            this.#identity.setRuntimeSession(storageSessionKey, nextRuntimeSession);
        }

        const explicitRunId = stringField(payloadView, "runId");
        const isTerminal = isTerminalEvent(envelope.event, envelope.payload);
        const resumedCompactionRun =
            this.#clearDeferredCompactionSettlementOnContinuation(
                storageSessionKey,
                envelope,
                shouldPersist
            );
        const shouldRetainProviderEvent = shouldRetainRuntimeEvent(
            envelope.event,
            retentionPayload || payloadView,
            envelope.canonicalEvents
        );
        const replayEnvelope =
            shouldRetainProviderEvent || !resumedCompactionRun
                ? envelope
                : {
                      ...envelope,
                      canonicalEvents: [],
                      payload: {
                          miraReplayMarker: DEFERRED_COMPACTION_CONTINUATION_MARKER,
                          runId: explicitRunId || resumedCompactionRun.runId,
                          sessionKey: storageSessionKey,
                      },
                  };
        const associationBytes = explicitRunId
            ? Buffer.byteLength(
                  JSON.stringify({ runId: explicitRunId, sessionKey: storageSessionKey })
              )
            : 0;
        const isTranscriptBackedControl = envelope.canonicalEvents.some(
            (canonicalEvent) => canonicalEvent.kind === "control"
        );
        if (
            explicitRunId &&
            !isTranscriptBackedControl &&
            associationBytes <= MAX_BYTES_PER_EVENT
        ) {
            this.#identity.rememberRunSession(explicitRunId, storageSessionKey);
        }
        if (!shouldRetainProviderEvent && !resumedCompactionRun) {
            if (didReplaceRuntimeSession) {
                this.#persistence.queueSession(storageSessionKey);
            }
            return [];
        }
        const serializedBytes = Buffer.byteLength(JSON.stringify(replayEnvelope));
        let retainedEnvelope: OpenClawRuntimeEnvelope | undefined;
        if (isTerminal) {
            retainedEnvelope = boundedCanonicalRuntimeEnvelope(
                withCurrentCanonicalOpenClawIdentity({
                    ...envelope,
                    payload: compactTerminalPayload(
                        payload,
                        explicitRunId,
                        storageSessionKey
                    ),
                })
            );
        }
        if (serializedBytes <= MAX_BYTES_PER_EVENT) {
            retainedEnvelope = replayEnvelope;
        }
        if (!retainedEnvelope) {
            return [];
        }

        const retainedBytes =
            retainedEnvelope === envelope
                ? serializedBytes
                : Buffer.byteLength(JSON.stringify(retainedEnvelope));
        if (retainedBytes > MAX_BYTES_PER_EVENT) {
            return [];
        }

        if (shouldPersist) {
            this.#pruneStaleActiveRuns(storageSessionKey);
        }
        const runs =
            this.#runsBySession.get(storageSessionKey) || new Map<string, RetainedRun>();
        let runtimeRunAliases: string[] = [];
        if (explicitRunId && !runs.has(explicitRunId)) {
            const interruptedRuns = promotableInterruptedConversationRuns(
                retainedEnvelope,
                runs,
                this.#requestBoundaries.blocking(storageSessionKey)
            );
            runtimeRunAliases = interruptedRuns.map((run) => run.runId);
            if (interruptedRuns.length > 0) {
                this.#clearSettledRequestBoundariesWithinRun(
                    storageSessionKey,
                    Math.min(...interruptedRuns.map((run) => firstSequence(run)))
                );
            }
            let promotedRun: RetainedRun | undefined;
            for (const interruptedRun of interruptedRuns) {
                promotedRun = this.#promoteRunEntry(
                    storageSessionKey,
                    runs,
                    interruptedRun.runId,
                    explicitRunId
                );
            }
            const pendingUserRuns =
                interruptedRuns.length > 0
                    ? []
                    : runs
                          .values()
                          .filter((run) =>
                              isPromotableRunlessUserLedRun(run, retainedEnvelope, runs)
                          )
                          .toArray();
            if (pendingUserRuns.length === 1) {
                promotedRun = this.#promoteRunEntry(
                    storageSessionKey,
                    runs,
                    pendingUserRuns[0]!.runId,
                    explicitRunId
                );
            }
            if (promotedRun && !shouldPersist) {
                this.#persistence.queueSession(storageSessionKey);
            }
        }
        this.#clearDeferredCompactionSettlementOnContinuation(
            storageSessionKey,
            envelope,
            shouldPersist
        );
        const activeRuns = runs
            .values()
            .filter((snapshot) => !snapshot.completed)
            .toArray();
        const isCompaction = isCompactionEvent(envelope.event, envelope.payload);
        const activeConversationRuns = activeRuns.filter(
            (run) => !isCompactionOnlyRun(run)
        );
        const canSettleOnlyCompaction =
            activeConversationRuns.length === 0 &&
            isSettlingLifecycleEvent(envelope.event, envelope.payload);
        const compatibleActiveRuns =
            isCompaction || canSettleOnlyCompaction ? activeRuns : activeConversationRuns;
        const activeRunlessRuns = compatibleActiveRuns.filter((run) =>
            isRunlessRunId(run.runId)
        );
        let compatibleActiveRun: RetainedRun | undefined;
        if (activeRunlessRuns.length === 1) {
            compatibleActiveRun = activeRunlessRuns[0];
        }
        if (compatibleActiveRuns.length === 1) {
            compatibleActiveRun = compatibleActiveRuns[0];
        }
        const isMetadataOnlyCompletion =
            !explicitRunId && isMetadataOnlyCompletionEnvelope(retainedEnvelope);
        const completedRuns =
            isCompaction ||
            (!explicitRunId &&
                (isMetadataOnlyCompletion || envelope.event === "session.message"))
                ? runs
                      .values()
                      .filter((run) => run.completed)
                      .toArray()
                      .toSorted(
                          (left, right) => right.terminalSequence - left.terminalSequence
                      )
                : [];
        const latestMeaningfulCompletion = completedRuns.find(
            (run) => !isAuxiliaryOnlyCompletion(run)
        );
        const hasNewerActiveRunlessWork = Boolean(
            compatibleActiveRun &&
            isRunlessRunId(compatibleActiveRun.runId) &&
            lastSequence(compatibleActiveRun) >
                (latestMeaningfulCompletion?.terminalSequence ?? -1)
        );
        if (
            isMetadataOnlyCompletion &&
            latestMeaningfulCompletion &&
            !hasNewerActiveRunlessWork
        ) {
            return [];
        }
        const metadataCompletionRun = isMetadataOnlyCompletion
            ? completedRuns.find((run) => isMetadataOnlyRunlessCompletion(run))
            : undefined;
        const completedEchoRun =
            !explicitRunId &&
            latestMeaningfulCompletion &&
            envelope.event === "session.message" &&
            hasChatFinal(latestMeaningfulCompletion) &&
            isMatchingSessionEcho(latestMeaningfulCompletion, envelope)
                ? latestMeaningfulCompletion
                : undefined;
        const retainedExplicitRunId =
            explicitRunId && (!isCompaction || runs.has(explicitRunId))
                ? explicitRunId
                : undefined;
        const runId =
            retainedExplicitRunId ||
            completedEchoRun?.runId ||
            compatibleActiveRun?.runId ||
            (isCompaction ? latestMeaningfulCompletion?.runId : undefined) ||
            explicitRunId ||
            metadataCompletionRun?.runId ||
            `runless:${envelope.runtimeSequence}`;
        let snapshot = runs.get(runId);

        if (!snapshot) {
            snapshot = {
                completed: false,
                eventBytes: [],
                events: [],
                firstSequence: envelope.runtimeSequence,
                interruptionEligible: !shouldPersist,
                runId,
                terminalSequence: -1,
                totalBytes: 0,
                updatedAt: retainedEnvelope.runtimeRecordedAt,
            };
            runs.set(runId, snapshot);
        }
        const previousEnvelope = snapshot.events.at(-1);
        // Codex auto-compaction ends its own lifecycle before the parent response
        // resumes. Treat that adjacent settlement as part of the nested compaction;
        // completing the parent here would compact tool replay that is not in
        // chat.history yet.
        const settlesNestedCompaction = Boolean(
            isSuccessfulLifecycleSettlementEvent(envelope.event, envelope.payload) &&
            !isCompactionOnlyRun(snapshot) &&
            previousEnvelope &&
            isCompactionEvent(previousEnvelope.event, previousEnvelope.payload)
        );
        snapshot.firstSequence = Math.min(
            snapshot.firstSequence,
            envelope.runtimeSequence
        );

        if (!isCompaction && snapshot.completed && isCompactionOnlyRun(snapshot)) {
            snapshot.completed = false;
            snapshot.terminalSequence = -1;
        }

        const coalescingKey = replayCoalescingKey(retainedEnvelope);
        const coalescingIndex = coalescingKey
            ? snapshot.events.findLastIndex(
                  (candidate) => replayCoalescingKey(candidate) === coalescingKey
              )
            : -1;
        if (coalescingIndex === -1) {
            snapshot.events.push(retainedEnvelope);
            snapshot.eventBytes.push(retainedBytes);
            snapshot.totalBytes += retainedBytes;
        } else {
            const coalescedEnvelope = coalesceReplayEnvelope(
                snapshot.events[coalescingIndex]!,
                retainedEnvelope
            );
            const coalescedBytes = Buffer.byteLength(JSON.stringify(coalescedEnvelope));
            const replayEnvelope =
                coalescedBytes <= MAX_BYTES_PER_EVENT
                    ? coalescedEnvelope
                    : retainedEnvelope;
            const replayBytes =
                replayEnvelope === coalescedEnvelope ? coalescedBytes : retainedBytes;
            snapshot.events.splice(coalescingIndex, 1);
            snapshot.totalBytes -= snapshot.eventBytes.splice(coalescingIndex, 1)[0] || 0;
            snapshot.events.push(replayEnvelope);
            snapshot.eventBytes.push(replayBytes);
            snapshot.totalBytes += replayBytes;
        }
        trimRetainedRun(snapshot);
        if (settlesNestedCompaction) {
            snapshot.pendingCompactionSettlementAt = retainedEnvelope.runtimeRecordedAt;
            snapshot.pendingCompactionSettlementSequence =
                retainedEnvelope.runtimeSequence;
        }
        const completesRun =
            isTerminal &&
            !settlesNestedCompaction &&
            (!isCompaction || snapshot.completed || isCompactionOnlyRun(snapshot));
        if (completesRun) {
            snapshot.terminalSequence = envelope.runtimeSequence;
        }
        snapshot.completed ||= completesRun;
        if (snapshot.completed) {
            snapshot.pendingCompactionSettlementAt = undefined;
            snapshot.pendingCompactionSettlementSequence = undefined;
            this.#clearDeferredCompactionTimer(storageSessionKey, snapshot.runId);
            // Completed tool calls are durable in chat.history. Keep the runtime-only
            // thinking/control stream while bounding the long-term SQLite footprint.
            compactCompletedRun(snapshot);
        }
        snapshot.updatedAt = Math.max(
            snapshot.updatedAt,
            retainedEnvelope.runtimeRecordedAt
        );

        while (runs.size > MAX_RUNS_PER_SESSION) {
            const oldestRunId = runs
                .values()
                .toArray()
                .toSorted((left, right) => left.updatedAt - right.updatedAt)[0]?.runId;
            if (!oldestRunId) {
                break;
            }
            this.#clearDeferredCompactionTimer(storageSessionKey, oldestRunId);
            runs.delete(oldestRunId);
            this.#identity.forgetRunSession(oldestRunId, storageSessionKey);
        }

        this.#runsBySession.set(storageSessionKey, runs);
        if (settlesNestedCompaction) {
            this.#scheduleDeferredCompactionSettlement(storageSessionKey, snapshot);
        }
        this.#enforceSessionLimit();
        this.#enforceReplayMemoryLimit(storageSessionKey);
        if (shouldPersist && this.#runsBySession.has(storageSessionKey)) {
            if (isTerminal) {
                this.#persistence.flushSession(storageSessionKey);
            } else {
                this.#persistence.queueSession(storageSessionKey);
            }
        } else if (didReplaceRuntimeSession) {
            this.#persistence.queueSession(storageSessionKey);
        }
        return runtimeRunAliases;
    }

    #dropMemoryState(): void {
        for (const timer of this.#deferredCompactionTimers.values()) {
            clearTimeout(timer);
        }
        this.#deferredCompactionTimers.clear();
        this.#runsBySession.clear();
        this.#identity.clear();
        this.#requestBoundaries.clear();
        this.#persistence.clearMemoryIndexes();
        this.#totalReplayBytes = 0;
    }

    #settleRequestBoundary(
        sessionKey: string,
        requestId: string | undefined,
        fallbackBoundary: number | undefined,
        isContinuation: boolean
    ): void {
        const changedSessionKeys = this.#requestBoundaries.settle(
            sessionKey,
            requestId,
            fallbackBoundary,
            isContinuation
        );
        for (const candidateSessionKey of changedSessionKeys) {
            if (this.#runsBySession.has(candidateSessionKey)) {
                this.#persistence.flushSession(candidateSessionKey);
            }
        }
    }

    #clearSettledRequestBoundariesWithinRun(
        sessionKey: string,
        firstRunSequence: number
    ): void {
        const changedSessionKeys = this.#requestBoundaries.clearSettledWithinRun(
            sessionKey,
            firstRunSequence
        );
        for (const changedSessionKey of changedSessionKeys) {
            this.#persistence.queueSession(changedSessionKey);
        }
    }

    #requestContinuesExistingRun(
        sessionKey: string,
        runId: string | undefined,
        requestBoundary?: number
    ): boolean {
        if (requestBoundary === undefined) {
            return false;
        }
        const activeCandidates = new Map<string, RetainedRun>();
        for (const [candidateSessionKey, runs] of this.#runsBySession) {
            if (!isSameSessionKey(candidateSessionKey, sessionKey)) {
                continue;
            }
            if (runId) {
                const run = runs.get(runId);
                if (run) {
                    const isContinuation = firstSequence(run) <= requestBoundary;
                    if (isContinuation) {
                        this.#clearSettledRequestBoundariesWithinRun(
                            sessionKey,
                            firstSequence(run)
                        );
                    }
                    return isContinuation;
                }
                continue;
            }
            const matchingRuns = runs
                .values()
                .filter((run) => isActiveConversationAtBoundary(run, requestBoundary));
            for (const run of matchingRuns) {
                const existing = activeCandidates.get(run.runId);
                if (!existing || lastSequence(run) > lastSequence(existing)) {
                    activeCandidates.set(run.runId, run);
                }
            }
        }
        if (runId || activeCandidates.size === 0) {
            return false;
        }
        const isContinuation =
            activeCandidates.size === 1 ||
            Boolean(this.#interruptedRunSplitCandidate(sessionKey, activeCandidates));
        if (isContinuation) {
            this.#clearSettledRequestBoundariesWithinRun(
                sessionKey,
                Math.min(...activeCandidates.values().map((run) => firstSequence(run)))
            );
        }
        return isContinuation;
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
            currentBytes: this.#totalReplayBytes,
            events,
            maxBytes: this.#maxReplayBytes,
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
        const storedKeys = this.#persistence.storedSessionKeys();
        if (!storedKeys) {
            return;
        }
        this.#withDeferredSessionLimit(() => {
            for (const sessionKey of storedKeys) {
                this.#ensureSessionLoaded(sessionKey);
            }
        });
        this.#enforceSessionLimit();
        this.#enforceReplayMemoryLimit();
    }

    /**
     * Allows one interrupted conversation to resume under a fresh provider run ID.
     * @param disconnectedAt Disconnected at timestamp.
     */
    markGatewayDisconnected(disconnectedAt = Date.now()): void {
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
                this.#clearDeferredCompactionTimer(sessionKey, run.runId);
            }
            if (interruptedRuns.length > 0) {
                this.#persistence.queueSession(sessionKey);
            }
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
                        this.#promoteSessionEntry(sessionKey, canonical, runId);
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
        this.#requireSequenceHydrated();
        if (sessionKey) {
            if (!this.#ensureEquivalentSessionsLoaded(sessionKey)) {
                throw new Error("Chat send boundary session could not be hydrated");
            }
            const storageSessionKey = normalizedSessionKey(sessionKey);
            const boundarySessionKeys = this.#runsBySession
                .entries()
                .filter(
                    ([candidateSessionKey, runs]) =>
                        isSameSessionKey(candidateSessionKey, storageSessionKey) &&
                        hasActiveConversationRun(runs)
                )
                .map(([candidateSessionKey]) => candidateSessionKey)
                .toArray();
            if (
                boundarySessionKeys.some(
                    (boundarySessionKey) =>
                        !this.#requestBoundaries.canCapture(boundarySessionKey, requestId)
                )
            ) {
                throw new Error("Too many pending chat requests for one session");
            }
            for (const boundarySessionKey of boundarySessionKeys) {
                this.#requestBoundaries.capture(
                    boundarySessionKey,
                    requestId,
                    this.#sequence
                );
            }
            let didPersistAll = true;
            for (const boundarySessionKey of boundarySessionKeys) {
                if (!this.#persistence.flushSession(boundarySessionKey)) {
                    didPersistAll = false;
                }
            }
            if (!didPersistAll) {
                this.#settleRequestBoundary(
                    storageSessionKey,
                    requestId,
                    this.#sequence,
                    true
                );
                throw new Error("Chat send boundary could not be persisted");
            }
        }
        return this.#sequence;
    }

    /**
     * Clears replay state associated with one reset, aborted, or deleted session.
     * @param sessionKey Session key value.
     */
    clearSession(sessionKey: string): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const sessionKeys = new Set([storageSessionKey]);
        for (const candidateSessionKey of this.#runsBySession.keys()) {
            if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                sessionKeys.add(candidateSessionKey);
            }
        }
        for (const candidateSessionKey of this.#persistence.pendingSessionKeys()) {
            if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                sessionKeys.add(candidateSessionKey);
            }
        }
        this.#requestBoundaries.forget(storageSessionKey);
        this.#persistence.beginSessionClear(storageSessionKey);
        const storedSessionKeys = this.#persistence.storedSessionKeys();
        if (storedSessionKeys) {
            for (const candidateSessionKey of storedSessionKeys) {
                if (isSameSessionKey(candidateSessionKey, storageSessionKey)) {
                    sessionKeys.add(candidateSessionKey);
                }
            }
        }
        for (const matchingSessionKey of sessionKeys) {
            this.#evictSessionFromMemory(matchingSessionKey);
        }
        if (!this.#persistence.enabled) {
            return;
        }

        let didClearAll = storedSessionKeys !== undefined;
        for (const matchingSessionKey of sessionKeys) {
            if (!this.#persistence.deleteSession(matchingSessionKey)) {
                didClearAll = false;
            }
        }
        this.#persistence.finishSessionClear(storageSessionKey, didClearAll);
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
        if (method === "chat.abort") {
            const sessionKey = stringField(parameters, "sessionKey");
            if (sessionKey) {
                this.clearSession(sessionKey);
            }
            return;
        }
        if (method === "sessions.delete") {
            const sessionKey = stringField(parameters, "key");
            if (sessionKey) {
                this.clearSession(sessionKey);
            }
            return;
        }
        if (method !== "chat.send") {
            return;
        }

        const sessionKey = stringField(parameters, "sessionKey");
        const message = stringField(parameters, "message");
        if (sessionKey && message && /^\/(?:new|reset)(?:\s|$)/i.test(message)) {
            this.clearSession(sessionKey);
            return;
        }
        const runId = stringField(asRecord(payload), "runId");
        const provisionalRunId = stringField(parameters, "idempotencyKey");
        if (sessionKey) {
            if (!this.#ensureEquivalentSessionsLoaded(sessionKey)) {
                // The provider has already accepted the send. Keep its durable
                // pending boundary intact until a later matching user echo can
                // hydrate and settle it; settling empty memory would strand a
                // stale cutoff in SQLite after the next restart.
                return;
            }
            const continuesExistingRun = this.#requestContinuesExistingRun(
                sessionKey,
                runId,
                requestBoundary
            );
            const pendingRequestBoundary = this.#requestBoundaries.pending(
                sessionKey,
                provisionalRunId,
                requestBoundary
            );
            if (
                !continuesExistingRun &&
                pendingRequestBoundary !== undefined &&
                (!runId || isProvisionalRunId(runId))
            ) {
                // A successful chat.send acknowledgement means that OpenClaw
                // accepted the request, not that its user event has entered the
                // transcript. During restart recovery it may remain queued while
                // the interrupted response resumes under another provider run.
                // Keep the boundary pending until that user echo establishes its
                // real position instead of turning the ACK into a false run split.
                const changedSessionKeys = this.#requestBoundaries.acknowledge(
                    sessionKey,
                    provisionalRunId,
                    requestBoundary
                );
                for (const changedSessionKey of changedSessionKeys) {
                    if (this.#runsBySession.has(changedSessionKey)) {
                        this.#persistence.flushSession(changedSessionKey);
                    }
                }
                const repaired = this.#repairInterruptedRunForSession(sessionKey);
                return repaired
                    ? this.#runtimeIdentityEnvelope(sessionKey, repaired)
                    : undefined;
            }
            let acknowledgedRunId =
                runId || (continuesExistingRun ? undefined : provisionalRunId);
            if (acknowledgedRunId) {
                this.#promoteProvisionalRun(
                    sessionKey,
                    acknowledgedRunId,
                    provisionalRunId,
                    requestBoundary
                );
            }
            this.#settleRequestBoundary(
                sessionKey,
                provisionalRunId,
                requestBoundary,
                continuesExistingRun
            );
            let repaired: RepairedInterruptedRun | undefined;
            if (!acknowledgedRunId && continuesExistingRun) {
                repaired = this.#repairInterruptedRunForSession(sessionKey);
                acknowledgedRunId = repaired?.providerRunId;
            }
            this.#clearCompletedRuns(sessionKey, acknowledgedRunId);
            if (acknowledgedRunId) {
                this.#identity.rememberRunSession(acknowledgedRunId, sessionKey);
            }
            return repaired
                ? this.#runtimeIdentityEnvelope(sessionKey, repaired)
                : undefined;
        }
        return undefined;
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
        if (method !== "chat.send") {
            return;
        }
        const sessionKey = stringField(parameters, "sessionKey");
        if (!sessionKey) {
            return;
        }
        this.#ensureEquivalentSessionsLoaded(sessionKey);
        this.#settleRequestBoundary(
            sessionKey,
            stringField(parameters, "idempotencyKey"),
            requestBoundary,
            true
        );
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
            this.#ensureSessionLoaded(providedSessionKey);
        }
        const enrichedPayload = this.#enrichPayload(event, payload, sessions);
        const enrichedSessionKey = stringField(asRecord(enrichedPayload), "sessionKey");
        if (enrichedSessionKey && enrichedSessionKey !== providedSessionKey) {
            this.#ensureSessionLoaded(enrichedSessionKey);
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
        const requestId = sessionMessageRequestId(event, enrichedPayload);
        let requestRepair: RepairedInterruptedRun | undefined;
        if (enrichedSessionKey && requestId) {
            const requestBoundary = this.#requestBoundaries.pending(
                enrichedSessionKey,
                requestId
            );
            if (requestBoundary !== undefined) {
                const runId = stringField(runtimePayloadView(enrichedPayload), "runId");
                requestRepair = this.#repairAcknowledgedProvisionalContinuationForSession(
                    enrichedSessionKey,
                    runId,
                    requestId,
                    requestBoundary
                );
                const isContinuation =
                    this.#requestContinuesExistingRun(
                        enrichedSessionKey,
                        runId,
                        requestBoundary
                    ) || Boolean(requestRepair);
                this.#settleRequestBoundary(
                    enrichedSessionKey,
                    requestId,
                    requestBoundary,
                    isContinuation
                );
            }
        }
        const runtimeRunAliases = [
            ...(requestRepair?.interruptedRunIds || []),
            ...this.#retain(envelope, true, runtimePayloadView(enrichedPayload)),
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
        this.#replayMemoryLimitDeferrals += 1;
        try {
            this.#ensureSessionLoaded(sessionKey);
            this.#completeExpiredCompactionSettlements(sessionKey);
            if (this.#pruneStaleActiveRuns(sessionKey)) {
                this.#persistence.flushSession(sessionKey);
            }
            return this.#snapshotFromMemory(sessionKey);
        } finally {
            this.#replayMemoryLimitDeferrals -= 1;
            this.#enforceReplayMemoryLimit(sessionKey);
        }
    }
}
