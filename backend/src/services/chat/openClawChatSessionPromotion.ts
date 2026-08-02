import { withCurrentCanonicalOpenClawIdentity } from "../../../../contracts/chat/openClawRuntimeAdapter.ts";
import type {
    OpenClawRuntimeEnvelope,
    OpenClawRuntimeSnapshot,
} from "../../../../contracts/chat/transport.ts";
import type { OpenClawChatCompactionSettlements } from "./openClawChatCompactionSettlements.ts";
import {
    isExactSessionKey,
    latestOptionalTimestamp,
    normalizedSessionKey,
    type OpenClawChatIdentityRegistry,
} from "./openClawChatIdentity.ts";
import { isTerminalEvent } from "./openClawChatLifecycle.ts";
import type { OpenClawChatPersistenceCoordinator } from "./openClawChatPersistence.ts";
import {
    asRecord,
    compactTerminalPayload,
    runtimePayloadView,
    stringField,
    withRuntimeIdentity,
} from "./openClawChatProviderAdapter.ts";
import type {
    OpenClawChatRequestBoundaries,
    OpenClawChatRequestBoundaryMetadata,
} from "./openClawChatRequestBoundaries.ts";
import {
    boundedCanonicalRuntimeEnvelope,
    MAX_BYTES_PER_EVENT,
    MAX_RUNS_PER_SESSION,
    snapshotFromRetainedRuns,
    type RetainedRun,
} from "./openClawChatRetention.ts";
import type { OpenClawChatRunReconciliation } from "./openClawChatRunReconciliation.ts";

interface OpenClawChatSessionPromotionOptions {
    compactionSettlements: OpenClawChatCompactionSettlements;
    currentSequence: () => number;
    enforceReplayMemoryLimit: (protectedSessionKey?: string) => void;
    enforceSessionLimit: (protectedSessionKey?: string) => void;
    ensureCanonicalDestinationLoaded: (canonicalSessionKey: string) => boolean;
    identity: OpenClawChatIdentityRegistry;
    persistence: OpenClawChatPersistenceCoordinator;
    requestBoundaries: OpenClawChatRequestBoundaries;
    runReconciliation: OpenClawChatRunReconciliation;
    runsBySession: Map<string, Map<string, RetainedRun>>;
}

/** Atomically promotes replay state from a provider alias to its canonical session. */
export class OpenClawChatSessionPromotion {
    readonly #compactionSettlements: OpenClawChatCompactionSettlements;
    readonly #currentSequence: () => number;
    readonly #enforceReplayMemoryLimit: (protectedSessionKey?: string) => void;
    readonly #enforceSessionLimit: (protectedSessionKey?: string) => void;
    readonly #ensureCanonicalDestinationLoaded: (canonicalSessionKey: string) => boolean;
    readonly #identity: OpenClawChatIdentityRegistry;
    readonly #persistence: OpenClawChatPersistenceCoordinator;
    readonly #requestBoundaries: OpenClawChatRequestBoundaries;
    readonly #runReconciliation: OpenClawChatRunReconciliation;
    readonly #runsBySession: Map<string, Map<string, RetainedRun>>;

    constructor(options: OpenClawChatSessionPromotionOptions) {
        this.#compactionSettlements = options.compactionSettlements;
        this.#currentSequence = options.currentSequence;
        this.#enforceReplayMemoryLimit = options.enforceReplayMemoryLimit;
        this.#enforceSessionLimit = options.enforceSessionLimit;
        this.#ensureCanonicalDestinationLoaded = options.ensureCanonicalDestinationLoaded;
        this.#identity = options.identity;
        this.#persistence = options.persistence;
        this.#requestBoundaries = options.requestBoundaries;
        this.#runReconciliation = options.runReconciliation;
        this.#runsBySession = options.runsBySession;
    }

    #cloneRetainedRun(run: RetainedRun): RetainedRun {
        return {
            ...run,
            eventBytes: [...run.eventBytes],
            events: [...run.events],
        };
    }

    #snapshotFromRuns(
        runs: ReadonlyMap<string, RetainedRun> | undefined,
        requestBoundaries: OpenClawChatRequestBoundaryMetadata
    ): OpenClawRuntimeSnapshot {
        return snapshotFromRetainedRuns(
            runs,
            this.#currentSequence(),
            true,
            requestBoundaries
        );
    }

    promoteSessionEntry(
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
            const rewrittenEvents = sourceRun.events.flatMap(
                (envelope): OpenClawRuntimeEnvelope[] => {
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
                    if (
                        Buffer.byteLength(JSON.stringify(rewritten)) <=
                        MAX_BYTES_PER_EVENT
                    ) {
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
                    return Buffer.byteLength(JSON.stringify(compact)) <=
                        MAX_BYTES_PER_EVENT
                        ? [compact]
                        : [];
                }
            );
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
        const sourceSnapshot = this.#snapshotFromRuns(nextSourceRuns, requestBoundaries);
        const canonicalSnapshot = this.#snapshotFromRuns(
            nextCanonicalRuns,
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
}
