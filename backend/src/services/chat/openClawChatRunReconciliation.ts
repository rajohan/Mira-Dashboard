import { withCurrentCanonicalOpenClawIdentity } from "../../../../contracts/chat/openClawRuntimeAdapter.ts";
import type { OpenClawRuntimeEnvelope } from "../../../../contracts/chat/transport.ts";
import type { OpenClawChatCompactionSettlements } from "./openClawChatCompactionSettlements.ts";
import {
    isAgentSessionKey,
    isSameSessionKey,
    normalizedSessionKey,
    OpenClawChatIdentityRegistry,
} from "./openClawChatIdentity.ts";
import {
    isConversationContinuationEvent,
    isTerminalEvent,
} from "./openClawChatLifecycle.ts";
import {
    asRecord,
    compactTerminalPayload,
    runtimePayloadView,
    stringField,
    withRuntimeIdentity,
} from "./openClawChatProviderAdapter.ts";
import type { OpenClawChatRequestBoundaries } from "./openClawChatRequestBoundaries.ts";
import {
    boundedCanonicalRuntimeEnvelope,
    firstSequence,
    isCompactionOnlyRun,
    lastSequence,
    MAX_BYTES_PER_EVENT,
    trimRetainedRun,
    type RetainedRun,
} from "./openClawChatRetention.ts";
import {
    INTERRUPTED_RUN_PROMOTION_WINDOW_MS,
    isProvisionalRunId,
    isRunlessRunId,
    promotableInterruptedConversationRuns,
    type RepairedInterruptedRun,
} from "./openClawChatRunIdentity.ts";

interface OpenClawChatRunReconciliationOptions {
    clearSettledRequestBoundariesWithinRun: (
        sessionKey: string,
        firstSequence: number
    ) => void;
    compactionSettlements: OpenClawChatCompactionSettlements;
    enforceReplayMemoryLimit: (protectedSessionKey?: string) => void;
    flushSession: (sessionKey: string) => boolean;
    identity: OpenClawChatIdentityRegistry;
    promoteSessionEntry: (
        sourceSessionKey: string,
        canonicalSessionKey: string,
        preferredRunId?: string
    ) => boolean;
    requestBoundaries: OpenClawChatRequestBoundaries;
    runsBySession: Map<string, Map<string, RetainedRun>>;
}

/** Owns replay run merging, interrupted-run repair, and provider promotion. */
export class OpenClawChatRunReconciliation {
    readonly #clearSettledRequestBoundariesWithinRun: (
        sessionKey: string,
        firstSequence: number
    ) => void;
    readonly #compactionSettlements: OpenClawChatCompactionSettlements;
    readonly #enforceReplayMemoryLimit: (protectedSessionKey?: string) => void;
    readonly #flushSession: (sessionKey: string) => boolean;
    readonly #identity: OpenClawChatIdentityRegistry;
    readonly #promoteSessionEntry: (
        sourceSessionKey: string,
        canonicalSessionKey: string,
        preferredRunId?: string
    ) => boolean;
    readonly #requestBoundaries: OpenClawChatRequestBoundaries;
    readonly #runsBySession: Map<string, Map<string, RetainedRun>>;

    constructor(options: OpenClawChatRunReconciliationOptions) {
        this.#clearSettledRequestBoundariesWithinRun =
            options.clearSettledRequestBoundariesWithinRun;
        this.#compactionSettlements = options.compactionSettlements;
        this.#enforceReplayMemoryLimit = options.enforceReplayMemoryLimit;
        this.#flushSession = options.flushSession;
        this.#identity = options.identity;
        this.#promoteSessionEntry = options.promoteSessionEntry;
        this.#requestBoundaries = options.requestBoundaries;
        this.#runsBySession = options.runsBySession;
    }

    replaceRunEvents(run: RetainedRun, events: OpenClawRuntimeEnvelope[]): void {
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
        this.replaceRunEvents(run, events);
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
            this.#compactionSettlements.mergeState(existing, provisional);
            this.replaceRunEvents(existing, [...provisional.events, ...existing.events]);
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

    promoteRunEntry(
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
            this.#compactionSettlements.rescheduleForSession(sessionKey);
        }
        return promotedRun;
    }

    repairInterruptedRunSplit(
        sessionKey: string,
        runs: Map<string, RetainedRun>
    ): RepairedInterruptedRun | undefined {
        const candidate = this.interruptedRunSplitCandidate(sessionKey, runs);
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

    interruptedRunSplitCandidate(
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

    repairInterruptedRunForSession(
        sessionKey: string
    ): RepairedInterruptedRun | undefined {
        const candidates = this.#runsBySession
            .entries()
            .filter(([candidateSessionKey]) =>
                isSameSessionKey(candidateSessionKey, sessionKey)
            )
            .flatMap(([candidateSessionKey, runs]) => {
                const candidate = this.interruptedRunSplitCandidate(
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
        const repaired = this.repairInterruptedRunSplit(candidateSessionKey, runs);
        if (!repaired) {
            return undefined;
        }
        for (const interruptedRunId of repaired.interruptedRunIds) {
            this.#identity.forgetRunSession(interruptedRunId, candidateSessionKey);
        }
        this.#identity.rememberRunSession(repaired.providerRunId, candidateSessionKey);
        this.#compactionSettlements.rescheduleForSession(candidateSessionKey);
        this.#enforceReplayMemoryLimit(candidateSessionKey);
        this.#flushSession(candidateSessionKey);
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

    repairAcknowledgedProvisionalContinuationForSession(
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
        this.#flushSession(candidateSessionKey);
        return candidate;
    }

    promoteProvisionalRun(
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
            this.promoteRunEntry(
                storageSessionKey,
                runs,
                preferredProvisionalRunId,
                providerRunId
            );
            this.#enforceReplayMemoryLimit(storageSessionKey);
            this.#flushSession(storageSessionKey);
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

        this.promoteRunEntry(
            storageSessionKey,
            runs,
            provisionalEntries[0]![0],
            providerRunId
        );
        this.#enforceReplayMemoryLimit(storageSessionKey);
        this.#flushSession(storageSessionKey);
    }
}
