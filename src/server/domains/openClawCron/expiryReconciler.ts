import {
    type OpenClawCronIntentStore,
    openClawCronExpiredIntentBatchMaximum,
} from "./intentStore.ts";
import { type OpenClawCronService, OpenClawCronServiceError } from "./service.ts";

export const openClawCronExpiryReconciliationIntervalMs = 10_000;
export const openClawCronExpiryReconciliationBatchSize = 32;

export interface OpenClawCronExpiryReconciliationFailure {
    readonly externalJobId?: string;
    readonly reason:
        | OpenClawCronServiceError["reason"]
        | "inventory-unavailable"
        | "unexpected";
}

export interface OpenClawCronExpiryReconciliationResult {
    readonly attempted: number;
    readonly failed: number;
    readonly hasMore: boolean;
    readonly reconciled: number;
}

export interface OpenClawCronExpiryReconciler {
    reconcile(signal?: AbortSignal): Promise<OpenClawCronExpiryReconciliationResult>;
    start(): void;
    stop(force?: boolean): Promise<void>;
}

interface OpenClawCronExpiryTimer {
    cancel(handle: unknown): void;
    schedule(callback: () => void, delayMs: number): unknown;
}

export interface OpenClawCronExpiryReconcilerOptions {
    readonly batchSize?: number;
    readonly clock?: () => number;
    readonly intentStore: Pick<OpenClawCronIntentStore, "listExpired">;
    readonly intervalMs?: number;
    readonly onFailure?: (failure: OpenClawCronExpiryReconciliationFailure) => void;
    readonly service: Pick<OpenClawCronService, "reconcileExpired">;
    readonly timer?: OpenClawCronExpiryTimer;
}

const defaultTimer: OpenClawCronExpiryTimer = Object.freeze({
    cancel: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    schedule: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
});

function boundedPositiveInteger(value: number, maximum: number, label: string): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
        throw new RangeError(`${label} is outside its budget`);
    }
    return value;
}

function reportFailure(
    callback: OpenClawCronExpiryReconcilerOptions["onFailure"],
    failure: OpenClawCronExpiryReconciliationFailure
): void {
    try {
        callback?.(Object.freeze(failure));
    } catch {
        // Observability defects never stop desired-state reconciliation.
    }
}

/**
 * Creates one bounded, lifecycle-owned reconciler for elapsed OpenClaw disable intents.
 * Provider errors are reduced to stable categories before observation.
 * @param options Persisted intent inventory, service, timing, and observation ports.
 * @returns One explicitly started and stopped expiry reconciler.
 */
export function createOpenClawCronExpiryReconciler(
    options: OpenClawCronExpiryReconcilerOptions
): OpenClawCronExpiryReconciler {
    const batchSize = boundedPositiveInteger(
        options.batchSize ?? openClawCronExpiryReconciliationBatchSize,
        openClawCronExpiredIntentBatchMaximum,
        "OpenClaw cron expiry batch size"
    );
    const intervalMs = boundedPositiveInteger(
        options.intervalMs ?? openClawCronExpiryReconciliationIntervalMs,
        60 * 60 * 1000,
        "OpenClaw cron expiry interval"
    );
    const clock = options.clock ?? Date.now;
    const timer = options.timer ?? defaultTimer;
    let activeAbort: AbortController | undefined;
    let activeRun: Promise<void> | undefined;
    let scheduled: unknown;
    let started = false;
    let stopped = false;
    let stopPromise: Promise<void> | undefined;
    let releaseForcedStop!: () => void;
    const forcedStop = new Promise<void>((resolve) => {
        releaseForcedStop = resolve;
    });

    async function reconcile(
        signal?: AbortSignal
    ): Promise<OpenClawCronExpiryReconciliationResult> {
        signal?.throwIfAborted();
        const atMs = clock();
        let targets;
        try {
            targets = await options.intentStore.listExpired(atMs, batchSize);
        } catch {
            if (signal?.aborted) signal.throwIfAborted();
            reportFailure(options.onFailure, { reason: "inventory-unavailable" });
            return { attempted: 0, failed: 1, hasMore: false, reconciled: 0 };
        }
        signal?.throwIfAborted();
        let failed = 0;
        let reconciled = 0;
        for (const target of targets) {
            signal?.throwIfAborted();
            try {
                await options.service.reconcileExpired(
                    { id: target.externalJobId },
                    signal
                );
                reconciled += 1;
            } catch (error) {
                if (signal?.aborted) signal.throwIfAborted();
                failed += 1;
                reportFailure(options.onFailure, {
                    externalJobId: target.externalJobId,
                    reason:
                        error instanceof OpenClawCronServiceError
                            ? error.reason
                            : "unexpected",
                });
            }
        }
        return {
            attempted: targets.length,
            failed,
            hasMore: targets.length === batchSize,
            reconciled,
        };
    }

    function schedule(delayMs: number): void {
        if (stopped || scheduled !== undefined || activeRun !== undefined) return;
        scheduled = timer.schedule(() => {
            scheduled = undefined;
            if (stopped) return;
            const controller = new AbortController();
            activeAbort = controller;
            let nextDelayMs = intervalMs;
            const run = (async () => {
                try {
                    const result = await reconcile(controller.signal);
                    nextDelayMs = result.hasMore ? 1 : intervalMs;
                } catch {
                    // A failed pass receives the ordinary bounded retry interval.
                }
            })();
            activeRun = run;
            void run.finally(() => {
                if (activeRun === run) activeRun = undefined;
                if (activeAbort === controller) activeAbort = undefined;
                if (!stopped) schedule(nextDelayMs);
            });
        }, delayMs);
    }

    return Object.freeze({
        reconcile,
        start() {
            if (stopped) {
                throw new TypeError("OpenClaw cron expiry reconciler is stopped");
            }
            if (started) return;
            started = true;
            schedule(1);
        },
        stop(force = false) {
            if (force) releaseForcedStop();
            if (stopPromise !== undefined) return stopPromise;
            stopped = true;
            if (scheduled !== undefined) {
                timer.cancel(scheduled);
                scheduled = undefined;
            }
            activeAbort?.abort();
            const run = activeRun;
            stopPromise = (async () => {
                if (run === undefined) return;
                try {
                    await Promise.race([run, forcedStop]);
                } catch {
                    // Aborted reconciliation is expected during ordered shutdown.
                }
            })();
            return stopPromise;
        },
    });
}
