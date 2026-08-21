import { addMilliseconds } from "date-fns";
import { Effect, Layer } from "effect";
import * as v from "valibot";

import {
    gatewayRealtimeChangeSchemas,
    gatewayRealtimeTopicDefinitions,
    gatewayRealtimeTopics,
} from "../../../contracts/gatewayRealtime.ts";
import { realtimeEventRetentionMilliseconds } from "../../../contracts/realtime.ts";
import type { MarkDatabaseTransactionStarted } from "../../database/immediateWriteAdmission.ts";
import type { RuntimeOwnedDatabase } from "../../database/runtime/databaseService.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import { RealtimeEventPumpService } from "../realtime/eventPumpService.ts";
import type {
    PersistentGatewayConnectionSnapshot,
    PersistentGatewayDeliveredEvent,
    PersistentGatewayEventGap,
    PersistentGatewayListener,
    PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

type GatewayRealtimeTopic =
    (typeof gatewayRealtimeTopics)[keyof typeof gatewayRealtimeTopics];

export type PersistentGatewayRealtimeEventInsert = v.InferOutput<
    typeof realtimeEventInsertSchema
>;

export type PersistentGatewayRealtimeBridgeFailureStage = "append" | "wake";

export interface PersistentGatewayRealtimeBridgeFailure {
    readonly cause: unknown;
    readonly stage: PersistentGatewayRealtimeBridgeFailureStage;
    readonly topic: GatewayRealtimeTopic;
}

export interface PersistentGatewayRealtimeBridgeOptions {
    readonly appendEvent: (event: PersistentGatewayRealtimeEventInsert) => Promise<void>;
    readonly nowMs?: () => number;
    readonly onFailure?: (failure: PersistentGatewayRealtimeBridgeFailure) => void;
    readonly retry?: {
        readonly factor?: number;
        readonly initialDelayMs?: number;
        readonly maximumDelayMs?: number;
    };
    readonly scheduler?: PersistentGatewayRealtimeBridgeScheduler;
    readonly transport: Pick<PersistentGatewayTransport, "subscribe">;
    readonly wake: () => Promise<void> | void;
}

type RetryTimerHandle = number | object;

/** Injectable retry timer authority used by deterministic bridge tests. */
export interface PersistentGatewayRealtimeBridgeScheduler {
    readonly clearTimeout: (handle: RetryTimerHandle) => void;
    readonly setTimeout: (callback: () => void, delayMs: number) => RetryTimerHandle;
}

/** Process-owned durable invalidation bridge with an explicitly bounded pending set. */
export interface PersistentGatewayRealtimeBridge {
    dispose(): Promise<void>;
    start(): void;
}

export interface PersistentGatewayRealtimeLifecycleLayerOptions extends Omit<
    PersistentGatewayRealtimeBridgeOptions,
    "transport" | "wake"
> {
    readonly transport: PersistentGatewayTransport;
}

const snapshotRequiredPayload = Object.freeze({ kind: "snapshot-required" as const });
const snapshotRequiredPayloadJson = JSON.stringify(snapshotRequiredPayload);
const gatewayRealtimeChangeSchema = v.union(gatewayRealtimeChangeSchemas);
const defaultRetryScheduler: PersistentGatewayRealtimeBridgeScheduler = Object.freeze({
    clearTimeout(handle: RetryTimerHandle) {
        globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
    setTimeout(callback: () => void, delayMs: number) {
        const handle = globalThis.setTimeout(callback, delayMs);
        handle.unref?.();
        return handle;
    },
});

function retryNumber(
    value: number | undefined,
    fallback: number,
    minimum: number,
    maximum: number,
    label: string
): number {
    const resolved = value ?? fallback;
    if (!Number.isFinite(resolved) || resolved < minimum || resolved > maximum) {
        throw new TypeError(`${label} is invalid`);
    }
    return resolved;
}

function entityTypeForTopic(topic: GatewayRealtimeTopic): string {
    const definition = gatewayRealtimeTopicDefinitions.find(
        (candidate) => candidate.topic === topic
    );
    if (definition === undefined || definition.entityTypes.length !== 1) {
        throw new TypeError("Gateway realtime topic definition is invalid");
    }
    return definition.entityTypes[0];
}

function createRealtimeEvent(
    topic: GatewayRealtimeTopic,
    occurredAtMs: number
): PersistentGatewayRealtimeEventInsert {
    const change = v.parse(gatewayRealtimeChangeSchema, {
        entityId: "current",
        entityType: entityTypeForTopic(topic),
        occurredAtMs,
        operation: "snapshot-required",
        payload: snapshotRequiredPayload,
        topic,
    });
    const occurredAt = new Date(change.occurredAtMs);
    return v.parse(realtimeEventInsertSchema, {
        entityId: change.entityId,
        entityType: change.entityType,
        expiresAt: addMilliseconds(occurredAt, realtimeEventRetentionMilliseconds),
        occurredAt,
        operation: change.operation,
        payloadJson: snapshotRequiredPayloadJson,
        topic: change.topic,
    });
}

function reportFailure(
    callback: PersistentGatewayRealtimeBridgeOptions["onFailure"],
    failure: PersistentGatewayRealtimeBridgeFailure
): void {
    try {
        callback?.(Object.freeze(failure));
    } catch {
        // Observability defects never expand or stop the invalidation write path.
    }
}

function connectionSnapshotsMatch(
    left: PersistentGatewayConnectionSnapshot,
    right: PersistentGatewayConnectionSnapshot
): boolean {
    return (
        left.connectedAtMs === right.connectedAtMs &&
        left.connectionGeneration === right.connectionGeneration &&
        left.lastActivityAtMs === right.lastActivityAtMs &&
        left.lastDisconnectedAtMs === right.lastDisconnectedAtMs &&
        left.lastEventSequence === right.lastEventSequence &&
        left.lastFailure === right.lastFailure &&
        left.nextReconnectAtMs === right.nextReconnectAtMs &&
        left.phase === right.phase &&
        left.reconnectAttempt === right.reconnectAttempt &&
        left.lastKnownGood?.connectedAtMs === right.lastKnownGood?.connectedAtMs &&
        left.lastKnownGood?.connectionId === right.lastKnownGood?.connectionId &&
        left.lastKnownGood?.protocol === right.lastKnownGood?.protocol &&
        left.lastKnownGood?.serverVersion === right.lastKnownGood?.serverVersion
    );
}

class PersistentGatewayRealtimeBridgeImplementation implements PersistentGatewayRealtimeBridge {
    readonly #listener: PersistentGatewayListener;
    readonly #options: Omit<
        PersistentGatewayRealtimeBridgeOptions,
        "nowMs" | "retry" | "scheduler"
    > & {
        readonly nowMs: () => number;
        readonly retry: {
            readonly factor: number;
            readonly initialDelayMs: number;
            readonly maximumDelayMs: number;
        };
        readonly scheduler: PersistentGatewayRealtimeBridgeScheduler;
    };
    readonly #pendingTopics = new Map<GatewayRealtimeTopic, object>();
    #accepting = false;
    #disposed = false;
    #disposePromise: Promise<void> | undefined;
    #drainPromise: Promise<boolean> | undefined;
    #lastConnectedGeneration: number | undefined;
    #lastConnectionSnapshot: PersistentGatewayConnectionSnapshot | undefined;
    #retryAttempt = 0;
    #retryTimer: RetryTimerHandle | undefined;
    #started = false;
    #unsubscribe: (() => void) | undefined;

    constructor(options: PersistentGatewayRealtimeBridgeOptions) {
        const initialDelayMs = retryNumber(
            options.retry?.initialDelayMs,
            250,
            1,
            60_000,
            "Persistent Gateway realtime retry delay"
        );
        const maximumDelayMs = retryNumber(
            options.retry?.maximumDelayMs,
            30_000,
            initialDelayMs,
            5 * 60_000,
            "Persistent Gateway realtime maximum retry delay"
        );
        this.#options = Object.freeze({
            appendEvent: options.appendEvent,
            nowMs: options.nowMs ?? Date.now,
            onFailure: options.onFailure,
            retry: Object.freeze({
                factor: retryNumber(
                    options.retry?.factor,
                    2,
                    1,
                    10,
                    "Persistent Gateway realtime retry factor"
                ),
                initialDelayMs,
                maximumDelayMs,
            }),
            scheduler: options.scheduler ?? defaultRetryScheduler,
            transport: options.transport,
            wake: options.wake,
        });
        this.#listener = Object.freeze({
            onEvent: (event: PersistentGatewayDeliveredEvent) => this.#onEvent(event),
            onEventGap: (gap: PersistentGatewayEventGap) => this.#onEventGap(gap),
            onState: (snapshot: PersistentGatewayConnectionSnapshot) =>
                this.#onState(snapshot),
        });
    }

    dispose(): Promise<void> {
        this.#disposePromise ??= this.#dispose();
        return this.#disposePromise;
    }

    start(): void {
        if (this.#disposed) {
            throw new TypeError("Persistent Gateway realtime bridge is disposed");
        }
        if (this.#started) return;
        this.#started = true;
        this.#accepting = true;
        try {
            this.#unsubscribe = this.#options.transport.subscribe(this.#listener);
        } catch (error) {
            this.#accepting = false;
            this.#started = false;
            throw error;
        }
    }

    async #dispose(): Promise<void> {
        this.#disposed = true;
        this.#accepting = false;
        const unsubscribe = this.#unsubscribe;
        this.#unsubscribe = undefined;
        try {
            unsubscribe?.();
        } catch {
            // Transport listeners are isolated; disposal remains idempotent.
        }
        this.#clearRetry();
        if (this.#drainPromise !== undefined) await this.#drainPromise;
        this.#clearRetry();
        if (this.#pendingTopics.size > 0) await this.#drain();
        this.#pendingTopics.clear();
    }

    async #drain(): Promise<boolean> {
        let failed = false;
        const pending = [...this.#pendingTopics.entries()];
        for (const [topic, identity] of pending) {
            if (await this.#write(topic)) {
                if (this.#pendingTopics.get(topic) === identity) {
                    this.#pendingTopics.delete(topic);
                }
            } else {
                failed = true;
            }
        }
        return failed;
    }

    #enqueue(topic: GatewayRealtimeTopic): void {
        if (!this.#accepting) return;
        this.#pendingTopics.set(topic, {});
        this.#scheduleDrain();
    }

    #scheduleDrain(): void {
        if (
            this.#disposed ||
            this.#drainPromise !== undefined ||
            this.#retryTimer !== undefined ||
            this.#pendingTopics.size === 0
        ) {
            return;
        }
        const drain = Promise.resolve().then(() => this.#drain());
        this.#drainPromise = drain;
        void drain.then((failed) => {
            if (this.#drainPromise !== drain) return false;
            this.#drainPromise = undefined;
            if (this.#pendingTopics.size === 0) {
                this.#retryAttempt = 0;
            } else if (failed) {
                this.#scheduleRetry();
            } else {
                this.#scheduleDrain();
            }
            return true;
        });
    }

    #clearRetry(): void {
        if (this.#retryTimer === undefined) return;
        this.#options.scheduler.clearTimeout(this.#retryTimer);
        this.#retryTimer = undefined;
    }

    #scheduleRetry(): void {
        if (
            this.#disposed ||
            this.#retryTimer !== undefined ||
            this.#pendingTopics.size === 0
        ) {
            return;
        }
        this.#retryAttempt += 1;
        const delayMs = Math.min(
            this.#options.retry.maximumDelayMs,
            Math.round(
                this.#options.retry.initialDelayMs *
                    this.#options.retry.factor ** (this.#retryAttempt - 1)
            )
        );
        this.#retryTimer = this.#options.scheduler.setTimeout(() => {
            this.#retryTimer = undefined;
            this.#scheduleDrain();
        }, delayMs);
    }

    #enqueueProviderSnapshots(): void {
        this.#enqueue(gatewayRealtimeTopics.sessions);
        this.#enqueue(gatewayRealtimeTopics.cron);
    }

    #onEvent(event: PersistentGatewayDeliveredEvent): void {
        if (event.frame.event === "sessions.changed") {
            this.#enqueue(gatewayRealtimeTopics.sessions);
        } else if (event.frame.event === "cron") {
            this.#enqueue(gatewayRealtimeTopics.cron);
        }
    }

    #onEventGap(_gap: PersistentGatewayEventGap): void {
        this.#enqueueProviderSnapshots();
    }

    #onState(snapshot: PersistentGatewayConnectionSnapshot): void {
        const previous = this.#lastConnectionSnapshot;
        if (previous !== undefined && connectionSnapshotsMatch(previous, snapshot)) {
            return;
        }
        this.#lastConnectionSnapshot = snapshot;
        this.#enqueue(gatewayRealtimeTopics.connection);
        const connectedGenerationChanged =
            snapshot.phase === "connected" &&
            snapshot.connectionGeneration !== this.#lastConnectedGeneration;
        const transitionedAwayFromConnected =
            previous?.phase === "connected" && snapshot.phase !== "connected";
        if (connectedGenerationChanged) {
            this.#lastConnectedGeneration = snapshot.connectionGeneration;
        }
        if (connectedGenerationChanged || transitionedAwayFromConnected) {
            this.#enqueueProviderSnapshots();
        }
    }

    async #write(topic: GatewayRealtimeTopic): Promise<boolean> {
        let event: PersistentGatewayRealtimeEventInsert;
        try {
            event = createRealtimeEvent(topic, this.#options.nowMs());
            await this.#options.appendEvent(event);
        } catch (error) {
            reportFailure(this.#options.onFailure, {
                cause: error,
                stage: "append",
                topic,
            });
            return false;
        }

        try {
            await this.#options.wake();
        } catch (error) {
            reportFailure(this.#options.onFailure, {
                cause: error,
                stage: "wake",
                topic,
            });
        }
        return true;
    }
}

/**
 * Creates one unstarted bridge. The caller owns its subscription lifetime.
 * @param options Durable append, pump wake, clock, and transport listener ports.
 * @returns A bounded topic-coalescing bridge.
 */
export function createPersistentGatewayRealtimeBridge(
    options: PersistentGatewayRealtimeBridgeOptions
): PersistentGatewayRealtimeBridge {
    return new PersistentGatewayRealtimeBridgeImplementation(options);
}

/**
 * Inserts one validated bridge event inside an admitted immediate transaction.
 * @param database Process-owned SQLite/Drizzle handle.
 * @param markTransactionStarted Admission marker called only after BEGIN IMMEDIATE.
 * @param input Prevalidated compact event candidate.
 * @returns Nothing after the event is committed.
 */
export function insertPersistentGatewayRealtimeEvent(
    database: RuntimeOwnedDatabase,
    markTransactionStarted: MarkDatabaseTransactionStarted,
    input: PersistentGatewayRealtimeEventInsert
): void {
    const event = v.parse(realtimeEventInsertSchema, input);
    database.$client
        .transaction(() => {
            markTransactionStarted();
            database.insert(realtimeEvents).values(event).run();
        })
        .immediate();
}

/**
 * Owns bridge subscription and transport lifetime after the realtime pump is acquired.
 * Stop transitions are persisted before the bridge unsubscribes and drains.
 * @param options Transport, append, clock, and failure-observation dependencies.
 * @returns A service-free lifecycle layer requiring the process realtime pump.
 */
export function persistentGatewayRealtimeLifecycleLayer(
    options: PersistentGatewayRealtimeLifecycleLayerOptions
): Layer.Layer<never, never, RealtimeEventPumpService> {
    return Layer.effectDiscard(
        RealtimeEventPumpService.pipe(
            Effect.flatMap((pump) =>
                Effect.acquireRelease(
                    Effect.promise(async () => {
                        const bridge = createPersistentGatewayRealtimeBridge({
                            ...options,
                            transport: options.transport,
                            wake: () => Effect.runSync(pump.wake),
                        });
                        bridge.start();
                        try {
                            options.transport.start();
                        } catch (error) {
                            await bridge.dispose();
                            throw error;
                        }
                        return bridge;
                    }),
                    (bridge) =>
                        Effect.promise(async () => {
                            try {
                                await options.transport.stop();
                            } finally {
                                await bridge.dispose();
                            }
                        })
                )
            )
        )
    );
}
