import type { OpenClawTasksService } from "../../domains/openClawTasks/service.ts";

export interface OpenClawTasksSubscriptionScheduler {
    readonly clearTimeout: (handle: unknown) => void;
    readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
}

export interface OpenClawTasksSubscriptionSupervisorOptions {
    readonly maximumRetryDelayMs?: number;
    readonly minimumRetryDelayMs?: number;
    readonly onFailure?: (error: unknown) => void;
    readonly scheduler?: OpenClawTasksSubscriptionScheduler;
    readonly service: Pick<OpenClawTasksService, "subscribe">;
}

export interface OpenClawTasksSubscriptionSupervisor {
    readonly start: () => void;
    readonly stop: () => Promise<void>;
}

const defaultScheduler: OpenClawTasksSubscriptionScheduler = Object.freeze({
    clearTimeout(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        const handle = setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
    },
});

/**
 * Supervises the durable task-invalidation bridge and retries terminal failures.
 * @param options Task service, retry policy, scheduler, and failure observer.
 * @returns One process-owned subscription supervisor.
 */
export function createOpenClawTasksSubscriptionSupervisor(
    options: OpenClawTasksSubscriptionSupervisorOptions
): OpenClawTasksSubscriptionSupervisor {
    const minimumRetryDelayMs = options.minimumRetryDelayMs ?? 1000;
    const maximumRetryDelayMs = options.maximumRetryDelayMs ?? 30_000;
    if (
        !Number.isSafeInteger(minimumRetryDelayMs) ||
        minimumRetryDelayMs < 1 ||
        !Number.isSafeInteger(maximumRetryDelayMs) ||
        maximumRetryDelayMs < minimumRetryDelayMs
    ) {
        throw new TypeError("OpenClaw tasks subscription retry policy is invalid");
    }
    const scheduler = options.scheduler ?? defaultScheduler;
    let active: Awaited<ReturnType<OpenClawTasksService["subscribe"]>> | undefined;
    let attempt = 0;
    let controller: AbortController | undefined;
    let retryHandle: unknown;
    let runPromise: Promise<void> | undefined;
    let runIdentity: object | undefined;
    let started = false;
    let stopped = false;
    let stopPromise: Promise<void> | undefined;

    const scheduleRetry = (): void => {
        if (stopped || retryHandle !== undefined) return;
        attempt += 1;
        const delayMs = Math.min(
            maximumRetryDelayMs,
            minimumRetryDelayMs * 2 ** Math.min(attempt - 1, 30)
        );
        retryHandle = scheduler.setTimeout(() => {
            retryHandle = undefined;
            connect();
        }, delayMs);
    };

    const connect = (): void => {
        if (stopped || runPromise !== undefined) return;
        controller = new AbortController();
        const signal = controller.signal;
        const identity = {};
        runIdentity = identity;
        const run = (async () => {
            try {
                const subscription = await options.service.subscribe(() => {}, signal);
                active = subscription;
                if (stopped) {
                    await subscription.close();
                    return;
                }
                await subscription.done;
                if (signal.aborted) return;
                throw new Error(
                    "OpenClaw tasks subscription ended without an explicit close"
                );
            } catch (error) {
                if (!stopped) {
                    options.onFailure?.(error);
                    scheduleRetry();
                }
            } finally {
                if (active !== undefined) active = undefined;
                if (controller?.signal === signal) controller = undefined;
                if (runIdentity === identity) {
                    runIdentity = undefined;
                    runPromise = undefined;
                }
            }
        })();
        runPromise = run;
    };

    return Object.freeze({
        start() {
            if (started || stopped) return;
            started = true;
            connect();
        },
        stop() {
            stopPromise ??= (async () => {
                stopped = true;
                if (retryHandle !== undefined) {
                    scheduler.clearTimeout(retryHandle);
                    retryHandle = undefined;
                }
                controller?.abort();
                await active?.close();
                await runPromise;
            })();
            return stopPromise;
        },
    });
}
