import {
    type OpenClawRuntimeEnvelope,
    type OpenClawRuntimeSnapshot,
} from "../../../../contracts/chat.ts";
import {
    withCanonicalOpenClawEvents,
    withCurrentCanonicalOpenClawIdentity,
} from "../../../../contracts/chat/openClawRuntimeAdapter.ts";
import type { ChatRuntimeMetrics } from "../../../../contracts/metrics.ts";
import {
    DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS,
    DEFERRED_COMPACTION_SETTLEMENT_TIMEOUT_REASON,
    NESTED_COMPACTION_SETTLEMENT_GRACE_MS,
    OpenClawChatCompactionSettlements,
} from "./openClawChatCompactionSettlements.ts";
import {
    isActiveConversationAtBoundary,
    isAgentSessionKey,
    isExactSessionKey,
    isProvisionalRunId,
    isSameSessionKey,
    latestOptionalTimestamp,
    normalizedSessionKey,
    OpenClawChatIdentityRegistry,
    sessionMessageRequestId,
    sessionMessageRunId,
    type OpenClawChatSessionIdentity,
    type RepairedInterruptedRun,
} from "./openClawChatIdentity.ts";
import { isTerminalEvent } from "./openClawChatLifecycle.ts";
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
    sessionMessageActiveRunIds,
    stringField,
    withRuntimeIdentity,
} from "./openClawChatProviderAdapter.ts";
import { OpenClawChatReplayRetention } from "./openClawChatReplayRetention.ts";
import {
    OpenClawChatRequestBoundaries,
    type OpenClawChatRequestBoundaryMetadata,
} from "./openClawChatRequestBoundaries.ts";
import {
    ACTIVE_RUN_TTL_MS,
    boundedCanonicalRuntimeEnvelope,
    firstSequence,
    hasActiveConversationRun,
    isCompactionOnlyRun,
    lastSequence,
    MAX_BYTES_ACROSS_REPLAY,
    MAX_BYTES_PER_EVENT,
    MAX_RUNS_PER_SESSION,
    oldestEvictableSessionKey,
    oldestReplayBudgetSessionKey,
    replayBytes,
    RETAINED_RUNTIME_EVENTS,
    snapshotFromRetainedRuns,
    type RetainedRun,
} from "./openClawChatRetention.ts";
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
    readonly #requestBoundaries = new OpenClawChatRequestBoundaries(
        normalizedSessionKey,
        isSameSessionKey
    );
    readonly #maxReplayBytes: number;
    readonly #now: () => number;
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
        this.#now = options.now ?? (() => Date.now());
        this.#persistence = new OpenClawChatPersistenceCoordinator(store, {
            ensureSessionLoaded: (sessionKey) => this.#ensureSessionLoaded(sessionKey),
            metrics: this.#metrics,
            snapshotFromMemory: (sessionKey) =>
                this.#snapshotFromMemory(sessionKey, true),
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
                this.#clearSettledRequestBoundariesWithinRun(sessionKey, firstSequence),
            compactionSettlements: this.#compactionSettlements,
            enforceReplayMemoryLimit: (protectedSessionKey) =>
                this.#enforceReplayMemoryLimit(protectedSessionKey),
            flushSession: (sessionKey) => this.#persistence.flushSession(sessionKey),
            identity: this.#identity,
            promoteSessionEntry: (
                sourceSessionKey,
                canonicalSessionKey,
                preferredRunId
            ) =>
                this.#promoteSessionEntry(
                    sourceSessionKey,
                    canonicalSessionKey,
                    preferredRunId
                ),
            requestBoundaries: this.#requestBoundaries,
            runsBySession: this.#runsBySession,
        });
        this.#replayRetention = new OpenClawChatReplayRetention({
            clearSettledRequestBoundariesWithinRun: (sessionKey, firstSequence) =>
                this.#clearSettledRequestBoundariesWithinRun(sessionKey, firstSequence),
            compactionSettlements: this.#compactionSettlements,
            enforceReplayMemoryLimit: (protectedSessionKey) =>
                this.#enforceReplayMemoryLimit(protectedSessionKey),
            enforceSessionLimit: (protectedSessionKey) =>
                this.#enforceSessionLimit(protectedSessionKey),
            identity: this.#identity,
            persistence: this.#persistence,
            pruneStaleActiveRuns: (sessionKey) => this.#pruneStaleActiveRuns(sessionKey),
            refreshTotalReplayBytes: () => this.#refreshTotalReplayBytes(),
            requestBoundaries: this.#requestBoundaries,
            runReconciliation: this.#runReconciliation,
            runsBySession: this.#runsBySession,
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
                this.#replayRetention.retain(envelope, false);
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
            this.#compactionSettlements.clearTimer(storedStorageKey, runId);
        }
        const repairedRunIdentity = hydratedRuns
            ? this.#runReconciliation.repairInterruptedRunSplit(
                  storedStorageKey,
                  hydratedRuns
              )
            : undefined;
        if (repairedRunIdentity) {
            for (const interruptedRunId of repairedRunIdentity.interruptedRunIds) {
                this.#identity.forgetRunSession(interruptedRunId, storedStorageKey);
            }
            this.#identity.rememberRunSession(
                repairedRunIdentity.providerRunId,
                storedStorageKey
            );
            this.#compactionSettlements.rescheduleForSession(storedStorageKey);
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
            this.#compactionSettlements.clearTimer(storageSessionKey, runId);
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
        this.#compactionSettlements.clearTimersForSession(storageSessionKey);
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
            this.#compactionSettlements.clearTimer(storageSessionKey, runId);
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
            this.#runReconciliation.replaceRunEvents(sourceRun, rewrittenEvents);
            movedRunIds.add(runId);
            if (sourceRun.events.length === 0) {
                nextSourceRuns.delete(runId);
                continue;
            }
            const existing = nextCanonicalRuns.get(runId);
            if (existing) {
                this.#compactionSettlements.mergeState(existing, sourceRun);
                this.#runReconciliation.replaceRunEvents(existing, [
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
                ? this.#runReconciliation.repairInterruptedRunSplit(
                      canonicalStorageKey,
                      nextCanonicalRuns
                  )
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
        this.#compactionSettlements.rescheduleForSession(sourceStorageKey);
        this.#compactionSettlements.rescheduleForSession(canonicalStorageKey);
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
            Boolean(
                this.#runReconciliation.interruptedRunSplitCandidate(
                    sessionKey,
                    activeCandidates
                )
            );
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
                const repaired =
                    this.#runReconciliation.repairInterruptedRunForSession(sessionKey);
                return repaired
                    ? this.#runtimeIdentityEnvelope(sessionKey, repaired)
                    : undefined;
            }
            let acknowledgedRunId =
                runId || (continuesExistingRun ? undefined : provisionalRunId);
            if (acknowledgedRunId) {
                this.#runReconciliation.promoteProvisionalRun(
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
                repaired =
                    this.#runReconciliation.repairInterruptedRunForSession(sessionKey);
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
                requestRepair =
                    this.#runReconciliation.repairAcknowledgedProvisionalContinuationForSession(
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
        this.#replayMemoryLimitDeferrals += 1;
        try {
            this.#ensureSessionLoaded(sessionKey);
            this.#compactionSettlements.completeExpired(sessionKey);
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
