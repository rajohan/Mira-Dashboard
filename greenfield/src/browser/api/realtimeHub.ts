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
    client: DashboardRealtimeClient
): DashboardRealtimeHub {
    const listeners = new Map<symbol, RealtimeHubListener>();
    let activeSubscription: DashboardRealtimeSubscription | undefined;
    let cursor = "0";
    let disposed = false;
    let generation = 0;
    let paused = false;

    function snapshotListeners(): RealtimeHubListener[] {
        const snapshot: RealtimeHubListener[] = [];
        for (const listener of listeners.values()) snapshot.push(listener);
        return snapshot;
    }

    function restartSubscription(): void {
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
            lastEventId: cursor,
            topics,
        });
        const subscriptionState: {
            terminal: boolean;
            value?: DashboardRealtimeSubscription;
        } = { terminal: false };
        const subscription = client.subscribe(input, {
            onData(output) {
                if (disposed || currentGeneration !== generation) return;
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
            activeSubscription?.unsubscribe();
            activeSubscription = undefined;
        },
        pause() {
            if (disposed || paused) return;
            paused = true;
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
                    restartSubscription();
                },
            });
        },
    };
    return Object.freeze(hub);
}
