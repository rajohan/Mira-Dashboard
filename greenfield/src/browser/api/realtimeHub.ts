import * as v from "valibot";

import {
    type RealtimeStreamInput,
    type RealtimeStreamOutput,
    realtimeStreamInputSchema,
} from "../../contracts/events.ts";
import type {
    DashboardRealtimeClient,
    DashboardRealtimeObserver,
    DashboardRealtimeSubscription,
} from "./realtimeClient.ts";

export type DashboardRealtimeTopic = RealtimeStreamInput["topics"][number];

/** Shared feature-facing subscription authority for one browser tab. */
export interface DashboardRealtimeHub {
    readonly dispose: () => void;
    readonly pause: () => void;
    readonly resume: () => void;
    readonly subscribe: (
        topics: readonly DashboardRealtimeTopic[],
        observer: DashboardRealtimeObserver
    ) => DashboardRealtimeSubscription;
}

export interface DashboardRealtimeHubScheduler {
    readonly clearTimeout: (handle: unknown) => void;
    readonly setTimeout: (callback: () => void, delayMs: number) => unknown;
}

const realtimeReconnectDelayMs = 1000;
const defaultScheduler: DashboardRealtimeHubScheduler = Object.freeze({
    clearTimeout(handle: unknown) {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        return setTimeout(callback, delayMs);
    },
});

interface RealtimeHubListener {
    readonly observer: DashboardRealtimeObserver;
    readonly topics: ReadonlySet<DashboardRealtimeTopic>;
}

function listenerAcceptsOutput(
    listener: RealtimeHubListener,
    output: RealtimeStreamOutput
): boolean {
    return (
        output.data.kind === "resync-required" ||
        listener.topics.has(output.data.event.topic)
    );
}

/**
 * Multiplexes feature topic listeners over one resumable tRPC SSE subscription.
 * @param client Validating browser realtime client.
 * @returns One tab-local topic hub with a shared durable cursor.
 */
export function createDashboardRealtimeHub(
    client: DashboardRealtimeClient,
    scheduler: DashboardRealtimeHubScheduler = defaultScheduler
): DashboardRealtimeHub {
    const listeners = new Map<symbol, RealtimeHubListener>();
    let activeSubscription: DashboardRealtimeSubscription | undefined;
    let cursor: string | undefined;
    let disposed = false;
    let generation = 0;
    let paused = false;
    let reconnectTimer: unknown;

    function cancelReconnect(): void {
        if (reconnectTimer === undefined) return;
        scheduler.clearTimeout(reconnectTimer);
        reconnectTimer = undefined;
    }

    function scheduleReconnect(): void {
        if (
            reconnectTimer !== undefined ||
            listeners.size === 0 ||
            disposed ||
            paused
        ) {
            return;
        }
        reconnectTimer = scheduler.setTimeout(() => {
            reconnectTimer = undefined;
            restartSubscription();
        }, realtimeReconnectDelayMs);
    }

    function snapshotListeners(): RealtimeHubListener[] {
        const snapshot: RealtimeHubListener[] = [];
        for (const listener of listeners.values()) snapshot.push(listener);
        return snapshot;
    }

    function restartSubscription(): void {
        cancelReconnect();
        generation += 1;
        const currentGeneration = generation;
        activeSubscription?.unsubscribe();
        activeSubscription = undefined;
        if (listeners.size === 0 || disposed || paused) return;

        const topics = [
            ...new Set(
                [...listeners.values()].flatMap((listener) => [...listener.topics])
            ),
        ].toSorted();
        const input = v.parse(realtimeStreamInputSchema, {
            ...(cursor === undefined ? {} : { lastEventId: cursor }),
            topics,
        });
        const subscriptionState: {
            terminal: boolean;
            value?: DashboardRealtimeSubscription;
        } = { terminal: false };
        const subscription = client.subscribe(input, {
            onData(output) {
                if (disposed || currentGeneration !== generation) return;
                cancelReconnect();
                cursor = output.id;
                for (const listener of snapshotListeners()) {
                    if (listenerAcceptsOutput(listener, output)) {
                        listener.observer.onData(output);
                    }
                }
            },
            onError(error) {
                if (disposed || currentGeneration !== generation) return;
                subscriptionState.terminal = true;
                if (activeSubscription === subscriptionState.value) {
                    activeSubscription = undefined;
                }
                subscriptionState.value?.unsubscribe();
                for (const listener of snapshotListeners()) {
                    listener.observer.onError?.(error);
                }
                scheduleReconnect();
            },
        });
        subscriptionState.value = subscription;
        if (disposed || currentGeneration !== generation || subscriptionState.terminal) {
            subscription.unsubscribe();
            return;
        }
        activeSubscription = subscription;
    }

    const hub: DashboardRealtimeHub = {
        dispose() {
            if (disposed) return;
            paused = true;
            disposed = true;
            generation += 1;
            listeners.clear();
            cancelReconnect();
            activeSubscription?.unsubscribe();
            activeSubscription = undefined;
        },
        pause() {
            if (disposed || paused) return;
            paused = true;
            cancelReconnect();
            generation += 1;
            activeSubscription?.unsubscribe();
            activeSubscription = undefined;
        },
        resume() {
            if (disposed) {
                throw new TypeError("Dashboard realtime hub is disposed");
            }
            if (!paused) return;
            paused = false;
            restartSubscription();
        },
        subscribe(topics, observer) {
            if (disposed) {
                throw new TypeError("Dashboard realtime hub is disposed");
            }
            const parsed = v.parse(realtimeStreamInputSchema, {
                topics: [...topics],
            });
            const id = Symbol("dashboard-realtime-listener");
            listeners.set(id, {
                observer,
                topics: new Set(parsed.topics),
            });
            restartSubscription();
            let active = true;
            return Object.freeze({
                unsubscribe() {
                    if (!active) return;
                    active = false;
                    listeners.delete(id);
                    if (listeners.size === 0) cancelReconnect();
                    restartSubscription();
                },
            });
        },
    };
    return Object.freeze(hub);
}
