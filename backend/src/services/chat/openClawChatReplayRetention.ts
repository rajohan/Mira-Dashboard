import { withCurrentCanonicalOpenClawIdentity } from "../../../../contracts/chat/openClawRuntimeAdapter.ts";
import type { OpenClawRuntimeEnvelope } from "../../../../contracts/chat/transport.ts";
import {
    DEFERRED_COMPACTION_CONTINUATION_MARKER,
    DEFERRED_COMPACTION_SETTLEMENT_TIMEOUT_REASON,
    type OpenClawChatCompactionSettlements,
} from "./openClawChatCompactionSettlements.ts";
import {
    normalizedSessionKey,
    OpenClawChatIdentityRegistry,
} from "./openClawChatIdentity.ts";
import {
    isCompactionEvent,
    isMetadataOnlyCompletionEnvelope,
    isSettlingLifecycleEvent,
    isSuccessfulLifecycleSettlementEvent,
    isTerminalEvent,
    runtimeSessionBoundary,
} from "./openClawChatLifecycle.ts";
import type { OpenClawChatPersistenceCoordinator } from "./openClawChatPersistence.ts";
import {
    asRecord,
    compactTerminalPayload,
    runtimePayloadView,
    runtimeSessionId,
    stringField,
} from "./openClawChatProviderAdapter.ts";
import type { OpenClawChatRequestBoundaries } from "./openClawChatRequestBoundaries.ts";
import {
    boundedCanonicalRuntimeEnvelope,
    coalesceReplayEnvelope,
    compactCompletedRun,
    firstSequence,
    hasChatFinal,
    isAuxiliaryOnlyCompletion,
    isCompactionOnlyRun,
    isMetadataOnlyRunlessCompletion,
    lastSequence,
    MAX_BYTES_PER_EVENT,
    MAX_RUNS_PER_SESSION,
    replayCoalescingKey,
    RETAINED_RUNTIME_EVENTS,
    shouldRetainRuntimeEvent,
    trimRetainedRun,
    type RetainedRun,
} from "./openClawChatRetention.ts";
import {
    isMatchingSessionEcho,
    isPromotableRunlessUserLedRun,
    isRunlessRunId,
    promotableInterruptedConversationRuns,
} from "./openClawChatRunIdentity.ts";
import type { OpenClawChatRunReconciliation } from "./openClawChatRunReconciliation.ts";

interface OpenClawChatReplayRetentionOptions {
    clearSettledRequestBoundariesWithinRun: (
        sessionKey: string,
        firstSequence: number
    ) => void;
    compactionSettlements: OpenClawChatCompactionSettlements;
    enforceReplayMemoryLimit: (protectedSessionKey?: string) => void;
    enforceSessionLimit: (protectedSessionKey?: string) => void;
    identity: OpenClawChatIdentityRegistry;
    persistence: OpenClawChatPersistenceCoordinator;
    pruneStaleActiveRuns: (sessionKey: string) => boolean;
    refreshTotalReplayBytes: () => void;
    requestBoundaries: OpenClawChatRequestBoundaries;
    runReconciliation: OpenClawChatRunReconciliation;
    runsBySession: Map<string, Map<string, RetainedRun>>;
}

/** Applies bounded replay retention to canonical live Gateway envelopes. */
export class OpenClawChatReplayRetention {
    readonly #clearSettledRequestBoundariesWithinRun: (
        sessionKey: string,
        firstSequence: number
    ) => void;
    readonly #compactionSettlements: OpenClawChatCompactionSettlements;
    readonly #enforceReplayMemoryLimit: (protectedSessionKey?: string) => void;
    readonly #enforceSessionLimit: (protectedSessionKey?: string) => void;
    readonly #identity: OpenClawChatIdentityRegistry;
    readonly #persistence: OpenClawChatPersistenceCoordinator;
    readonly #pruneStaleActiveRuns: (sessionKey: string) => boolean;
    readonly #refreshTotalReplayBytes: () => void;
    readonly #requestBoundaries: OpenClawChatRequestBoundaries;
    readonly #runReconciliation: OpenClawChatRunReconciliation;
    readonly #runsBySession: Map<string, Map<string, RetainedRun>>;

    constructor(options: OpenClawChatReplayRetentionOptions) {
        this.#clearSettledRequestBoundariesWithinRun =
            options.clearSettledRequestBoundariesWithinRun;
        this.#compactionSettlements = options.compactionSettlements;
        this.#enforceReplayMemoryLimit = options.enforceReplayMemoryLimit;
        this.#enforceSessionLimit = options.enforceSessionLimit;
        this.#identity = options.identity;
        this.#persistence = options.persistence;
        this.#pruneStaleActiveRuns = options.pruneStaleActiveRuns;
        this.#refreshTotalReplayBytes = options.refreshTotalReplayBytes;
        this.#requestBoundaries = options.requestBoundaries;
        this.#runReconciliation = options.runReconciliation;
        this.#runsBySession = options.runsBySession;
    }

    retain(
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
            this.#compactionSettlements.clearTimersForSession(storageSessionKey);
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
        const resumedCompactionRun = this.#compactionSettlements.clearOnContinuation(
            storageSessionKey,
            envelope,
            shouldPersist
        );
        const shouldRetainProviderEvent = shouldRetainRuntimeEvent(
            envelope.event,
            retentionPayload || payloadView,
            envelope.canonicalEvents
        );
        const continuationReplayEnvelope = resumedCompactionRun
            ? {
                  ...envelope,
                  canonicalEvents: [],
                  payload: {
                      miraReplayMarker: DEFERRED_COMPACTION_CONTINUATION_MARKER,
                      runId: explicitRunId || resumedCompactionRun.runId,
                      sessionKey: storageSessionKey,
                  },
              }
            : undefined;
        let replayEnvelope =
            shouldRetainProviderEvent || !continuationReplayEnvelope
                ? envelope
                : continuationReplayEnvelope;
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
        let serializedBytes = Buffer.byteLength(JSON.stringify(replayEnvelope));
        if (serializedBytes > MAX_BYTES_PER_EVENT && continuationReplayEnvelope) {
            replayEnvelope = continuationReplayEnvelope;
            serializedBytes = Buffer.byteLength(JSON.stringify(replayEnvelope));
        }
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
                promotedRun = this.#runReconciliation.promoteRunEntry(
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
                promotedRun = this.#runReconciliation.promoteRunEntry(
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
        this.#compactionSettlements.clearOnContinuation(
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
        const isDeferredCompactionSettlementTimeout =
            envelope.event === "model.completed" &&
            stringField(runtimePayloadView(envelope.payload), "completionReason") ===
                DEFERRED_COMPACTION_SETTLEMENT_TIMEOUT_REASON;
        if (completesRun) {
            snapshot.terminalSequence = envelope.runtimeSequence;
        }
        snapshot.completed ||= completesRun;
        if (snapshot.completed) {
            snapshot.pendingCompactionSettlementAt = undefined;
            snapshot.pendingCompactionSettlementSequence = undefined;
            this.#compactionSettlements.clearTimer(storageSessionKey, snapshot.runId);
            // Ordinary completions have durable tool rows in chat.history. A synthetic
            // settlement has no transcript final, so its runtime tool replay stays.
            if (!isDeferredCompactionSettlementTimeout) {
                compactCompletedRun(snapshot);
            }
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
            this.#compactionSettlements.clearTimer(storageSessionKey, oldestRunId);
            runs.delete(oldestRunId);
            this.#identity.forgetRunSession(oldestRunId, storageSessionKey);
        }

        this.#runsBySession.set(storageSessionKey, runs);
        if (settlesNestedCompaction) {
            this.#compactionSettlements.schedule(storageSessionKey, snapshot);
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
}
