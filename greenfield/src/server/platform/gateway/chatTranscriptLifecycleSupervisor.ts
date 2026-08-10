import type { ChatTranscriptLifecycleCoordinator } from "../../domains/chat/transcriptLifecycle.ts";
import type {
    PersistentGatewayConnectionSnapshot,
    PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

export interface ChatTranscriptLifecycleSupervisor {
    readonly ready: Promise<void>;
    readonly stop: () => Promise<void>;
}

export interface ChatTranscriptLifecycleSupervisorOptions {
    readonly lifecycle: ChatTranscriptLifecycleCoordinator;
    readonly nowMs?: () => number;
    readonly onFailure?: (error: unknown) => void;
    readonly retryDelayMs?: number;
    readonly scheduler?: ChatTranscriptLifecycleSupervisorScheduler;
    readonly transport: Pick<PersistentGatewayTransport, "subscribe">;
}

export interface ChatTranscriptLifecycleSupervisorScheduler {
    readonly clearTimeout: (handle: unknown) => void;
    readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
    readonly unref?: (handle: unknown) => void;
}

const defaultScheduler: ChatTranscriptLifecycleSupervisorScheduler = Object.freeze({
    clearTimeout(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        return setTimeout(callback, delayMs);
    },
    unref(handle: unknown) {
        (handle as ReturnType<typeof setTimeout>).unref?.();
    },
});

interface QueuedTransportBoundary {
    readonly connectionGeneration: number;
    readonly occurredAtMs: number;
}

function transportBoundaryIsNewer(
    candidate: QueuedTransportBoundary,
    baseline: QueuedTransportBoundary
): boolean {
    return candidate.connectionGeneration > baseline.connectionGeneration
        ? true
        : candidate.connectionGeneration === baseline.connectionGeneration &&
              candidate.occurredAtMs > baseline.occurredAtMs;
}

/**
 * Bridges lossy native session lifecycle signals into the durable chat fence.
 *
 * @returns A supervisor whose readiness proves the startup boundary persisted.
 */
export function createChatTranscriptLifecycleSupervisor(
    options: ChatTranscriptLifecycleSupervisorOptions
): ChatTranscriptLifecycleSupervisor {
    const nowMs = options.nowMs ?? Date.now;
    const retryDelayMs = options.retryDelayMs ?? 1000;
    if (
        !Number.isSafeInteger(retryDelayMs) ||
        retryDelayMs < 1 ||
        retryDelayMs > 60_000
    ) {
        throw new RangeError("Chat transcript lifecycle retry delay is invalid");
    }
    const scheduler = options.scheduler ?? defaultScheduler;
    const noRetryHandle = Symbol("no-chat-lifecycle-retry");
    let active = Promise.resolve();
    let activeAllBoundary: QueuedTransportBoundary | undefined;
    let activeAllBoundaryWriteStarted = false;
    let lossBoundaryGeneration: number | undefined;
    let lastState: PersistentGatewayConnectionSnapshot | undefined;
    let pendingAllBoundary: QueuedTransportBoundary | undefined;
    let retryHandle: unknown = noRetryHandle;
    let stopped = false;

    const report = (error: unknown): void => {
        try {
            options.onFailure?.(error);
        } catch {
            // Reporting cannot replace the durable reconciliation lane.
        }
    };
    const enqueue = (operation: () => Promise<unknown>): void => {
        const previous = active;
        active = (async () => {
            await previous;
            try {
                await operation();
            } catch (error: unknown) {
                report(error);
                scheduleBoundaryRetry();
            }
        })();
    };
    function scheduleBoundaryRetry(): void {
        if (stopped || retryHandle !== noRetryHandle) return;
        retryHandle = scheduler.setTimeout(() => {
            retryHandle = noRetryHandle;
            if (stopped) return;
            enqueue(() => options.lifecycle.markTransportBoundary(nowMs()));
        }, retryDelayMs);
        scheduler.unref?.(retryHandle);
    }
    const queueAllBoundary = (boundary: QueuedTransportBoundary): void => {
        if (stopped) return;
        if (activeAllBoundary !== undefined) {
            if (!activeAllBoundaryWriteStarted) {
                if (transportBoundaryIsNewer(boundary, activeAllBoundary)) {
                    activeAllBoundary = boundary;
                }
                return;
            }
            const retained = pendingAllBoundary ?? activeAllBoundary;
            if (transportBoundaryIsNewer(boundary, retained)) {
                pendingAllBoundary = boundary;
            }
            return;
        }
        activeAllBoundary = boundary;
        queueMicrotask(() => {
            if (stopped) {
                activeAllBoundary = undefined;
                pendingAllBoundary = undefined;
                return;
            }
            enqueue(async () => {
                activeAllBoundaryWriteStarted = true;
                const queuedBoundary = activeAllBoundary;
                if (queuedBoundary === undefined) return;
                try {
                    await options.lifecycle.markTransportBoundary(
                        queuedBoundary.occurredAtMs
                    );
                } finally {
                    activeAllBoundaryWriteStarted = false;
                    activeAllBoundary = undefined;
                    const followUp = pendingAllBoundary;
                    pendingAllBoundary = undefined;
                    if (!stopped && followUp !== undefined) {
                        queueAllBoundary(followUp);
                    }
                }
            });
        });
    };

    const unsubscribe = options.transport.subscribe({
        onEvent({ connectionGeneration, frame, receivedAtMs }) {
            if (stopped || frame.event !== "sessions.changed") return;
            const lifecycle = frame.sessionLifecycle;
            if (lifecycle === undefined || lifecycle.sessionKey === undefined) {
                queueAllBoundary({ connectionGeneration, occurredAtMs: receivedAtMs });
                return;
            }
            enqueue(() => options.lifecycle.observeLifecycleEvent(lifecycle));
        },
        onEventGap({ connectionGeneration }) {
            queueAllBoundary({ connectionGeneration, occurredAtMs: nowMs() });
        },
        onState(snapshot) {
            if (stopped) return;
            const previous = lastState;
            lastState = snapshot;
            if (previous === undefined) return;
            const disconnected =
                previous.phase === "connected" && snapshot.phase !== "connected";
            const replacedConnection =
                snapshot.phase === "connected" &&
                previous.connectionGeneration > 0 &&
                snapshot.connectionGeneration > previous.connectionGeneration;
            if (disconnected) {
                lossBoundaryGeneration = previous.connectionGeneration;
                queueAllBoundary({
                    connectionGeneration: previous.connectionGeneration,
                    occurredAtMs: nowMs(),
                });
                return;
            }
            if (replacedConnection) {
                const closesObservedLoss =
                    previous.phase !== "connected" &&
                    lossBoundaryGeneration !== undefined &&
                    previous.connectionGeneration >= lossBoundaryGeneration;
                lossBoundaryGeneration = undefined;
                if (!closesObservedLoss) {
                    queueAllBoundary({
                        connectionGeneration: snapshot.connectionGeneration,
                        occurredAtMs: nowMs(),
                    });
                }
                return;
            }
            if (snapshot.phase === "connected") lossBoundaryGeneration = undefined;
        },
    });
    const previous = active;
    const ready = (async () => {
        await previous;
        await options.lifecycle.markTransportBoundary(nowMs());
    })();
    active = (async () => {
        try {
            await ready;
        } catch (error: unknown) {
            report(error);
            scheduleBoundaryRetry();
        }
    })();

    return Object.freeze({
        ready,
        async stop() {
            if (stopped) return;
            stopped = true;
            unsubscribe();
            if (retryHandle !== noRetryHandle) {
                scheduler.clearTimeout(retryHandle);
                retryHandle = noRetryHandle;
            }
            await active;
        },
    });
}
