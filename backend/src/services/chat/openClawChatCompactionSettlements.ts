import type { OpenClawRuntimeEnvelope } from "../../../../contracts/chat/transport.ts";
import {
    normalizedSessionKey,
    promotableInterruptedConversationRuns,
} from "./openClawChatIdentity.ts";
import {
    isConversationContinuationEvent,
    isTerminalEvent,
} from "./openClawChatLifecycle.ts";
import { runtimePayloadView, stringField } from "./openClawChatProviderAdapter.ts";
import {
    isCompactionOnlyRun,
    lastSequence,
    type RetainedRun,
} from "./openClawChatRetention.ts";

export const NESTED_COMPACTION_SETTLEMENT_GRACE_MS = 60_000;
export const DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS = 1000;
export const DEFERRED_COMPACTION_CONTINUATION_MARKER = "nested-compaction-continuation";
export const DEFERRED_COMPACTION_SETTLEMENT_TIMEOUT_REASON =
    "nested-compaction-settlement-timeout";

type UnrefableTimer = ReturnType<typeof setTimeout> & { unref?: () => void };

interface OpenClawChatCompactionSettlementOptions {
    blockingRequestBoundary: (sessionKey: string) => number | undefined;
    gatewayConnected: boolean;
    getRuns: (sessionKey: string) => Map<string, RetainedRun> | undefined;
    graceMs: number;
    now: () => number;
    onDeferredEnvelope?: (envelope: OpenClawRuntimeEnvelope) => void;
    queueSession: (sessionKey: string) => void;
    recordSettlement: (sessionKey: string, runId: string) => OpenClawRuntimeEnvelope;
}

/** Owns deferred nested-compaction settlement state and timers. */
export class OpenClawChatCompactionSettlements {
    readonly #blockingRequestBoundary: (sessionKey: string) => number | undefined;
    readonly #getRuns: (sessionKey: string) => Map<string, RetainedRun> | undefined;
    readonly #graceMs: number;
    readonly #now: () => number;
    readonly #onDeferredEnvelope?: (envelope: OpenClawRuntimeEnvelope) => void;
    readonly #queueSession: (sessionKey: string) => void;
    readonly #recordSettlement: (
        sessionKey: string,
        runId: string
    ) => OpenClawRuntimeEnvelope;
    readonly #timers = new Map<string, ReturnType<typeof setTimeout>>();
    #gatewayConnected: boolean;
    #settlementResumeAt = 0;

    constructor(options: OpenClawChatCompactionSettlementOptions) {
        this.#blockingRequestBoundary = options.blockingRequestBoundary;
        this.#gatewayConnected = options.gatewayConnected;
        this.#getRuns = options.getRuns;
        this.#graceMs = options.graceMs;
        this.#now = options.now;
        this.#onDeferredEnvelope = options.onDeferredEnvelope;
        this.#queueSession = options.queueSession;
        this.#recordSettlement = options.recordSettlement;
    }

    #timerKey(sessionKey: string, runId: string): string {
        return `${normalizedSessionKey(sessionKey)}\u0000${runId}`;
    }

    clearTimer(sessionKey: string, runId: string): void {
        const key = this.#timerKey(sessionKey, runId);
        const timer = this.#timers.get(key);
        if (timer) {
            clearTimeout(timer);
            this.#timers.delete(key);
        }
    }

    clearTimersForSession(sessionKey: string): void {
        const prefix = `${normalizedSessionKey(sessionKey)}\u0000`;
        for (const [key, timer] of this.#timers) {
            if (!key.startsWith(prefix)) {
                continue;
            }
            clearTimeout(timer);
            this.#timers.delete(key);
        }
    }

    clear(): void {
        for (const timer of this.#timers.values()) {
            clearTimeout(timer);
        }
        this.#timers.clear();
    }

    disconnect(): void {
        this.#gatewayConnected = false;
    }

    connect(): boolean {
        if (this.#gatewayConnected) {
            return false;
        }
        this.#gatewayConnected = true;
        this.#settlementResumeAt = this.#now() + DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS;
        return true;
    }

    rescheduleForSession(sessionKey: string, minimumDelayMs = 0): void {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        this.clearTimersForSession(storageSessionKey);
        const runs = this.#getRuns(storageSessionKey);
        if (!runs) {
            return;
        }
        for (const run of runs.values()) {
            if (run.pendingCompactionSettlementAt !== undefined && !run.completed) {
                this.schedule(storageSessionKey, run, minimumDelayMs);
            }
        }
    }

    mergeState(target: RetainedRun, source: RetainedRun): void {
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

    clearOnContinuation(
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
        const runs = this.#getRuns(storageSessionKey);
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
                this.#blockingRequestBoundary(storageSessionKey)
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
        this.clearTimer(storageSessionKey, run.runId);
        if (shouldPersist) {
            this.#queueSession(storageSessionKey);
        }
        return run;
    }

    schedule(sessionKey: string, run: RetainedRun, minimumDelayMs = 0): void {
        const pendingAt = run.pendingCompactionSettlementAt;
        if (pendingAt === undefined || run.completed || !this.#gatewayConnected) {
            this.clearTimer(sessionKey, run.runId);
            return;
        }
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const key = this.#timerKey(storageSessionKey, run.runId);
        this.clearTimer(storageSessionKey, run.runId);
        const now = this.#now();
        const delayMs = Math.max(
            minimumDelayMs,
            this.#settlementResumeAt - now,
            pendingAt + this.#graceMs - now
        );
        const timer = setTimeout(() => {
            this.#timers.delete(key);
            const didComplete = this.completeExpired(storageSessionKey, this.#now());
            if (didComplete) {
                return;
            }
            const pendingRun = this.#getRuns(storageSessionKey)?.get(run.runId);
            if (pendingRun?.pendingCompactionSettlementAt !== undefined) {
                this.schedule(
                    storageSessionKey,
                    pendingRun,
                    DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS
                );
            }
        }, delayMs);
        (timer as UnrefableTimer).unref?.();
        this.#timers.set(key, timer);
    }

    completeExpired(sessionKey: string, now = this.#now()): boolean {
        const storageSessionKey = normalizedSessionKey(sessionKey);
        const runs = this.#getRuns(storageSessionKey);
        if (!runs) {
            return false;
        }
        let didComplete = false;
        for (const run of runs.values()) {
            const pendingAt = run.pendingCompactionSettlementAt;
            if (
                run.completed ||
                !this.#gatewayConnected ||
                pendingAt === undefined ||
                now - pendingAt < this.#graceMs
            ) {
                continue;
            }
            this.clearTimer(storageSessionKey, run.runId);
            try {
                const envelope = this.#recordSettlement(storageSessionKey, run.runId);
                didComplete = true;
                try {
                    this.#onDeferredEnvelope?.(envelope);
                } catch {
                    // The retained completion remains durable if a live subscriber fails.
                }
            } catch {
                this.schedule(
                    storageSessionKey,
                    run,
                    DEFERRED_COMPACTION_SETTLEMENT_RETRY_MS
                );
            }
        }
        return didComplete;
    }
}
