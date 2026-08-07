import {
    type RealtimeEventDelivery,
    type RealtimeEventPollPlan,
    type RealtimeEventPumpMetrics,
    type RealtimeEventPumpOptions,
    type RealtimeEventSubscriptionOptions,
} from "./eventPumpContract.ts";
import { pollRealtimeEvents } from "./eventPumpPolling.ts";
import { RealtimeEventPumpState } from "./eventPumpState.ts";
import { subscribeRealtimeEvents } from "./eventPumpSubscription.ts";

export {
    RealtimeCursorError,
    realtimeEventPumpDefaults,
    RealtimeSubscriptionInputError,
} from "./eventPumpContract.ts";
export type {
    RealtimeChangeDelivery,
    RealtimeChangeEvent,
    RealtimeCursorErrorCode,
    RealtimeEventDelivery,
    RealtimeEventPollPlan,
    RealtimeEventPumpMetrics,
    RealtimeEventPumpOptions,
    RealtimeEventSubscriptionOptions,
    RealtimeEventSubscriptionStoreRead,
    RealtimeResyncRequiredDelivery,
    RealtimeRetainedEventsSample,
    RealtimeSubscriptionInputErrorCode,
} from "./eventPumpContract.ts";

/**
 * Durable SQLite event pump with bounded replay, one coalesced live poll, and explicit resync.
 * Transport and authentication adapters consume this iterator but remain outside this module.
 */
export class RealtimeEventPump {
    readonly #state: RealtimeEventPumpState;

    constructor(options: RealtimeEventPumpOptions) {
        this.#state = new RealtimeEventPumpState(options);
    }

    /** Coalesces an immediate poll request after a local transaction commits. */
    wake(): void {
        this.#state.wake();
    }

    /** Closes the pump and every active subscription. */
    close(): void {
        this.#state.close();
    }

    /**
     * Captures point-in-time operational counters and retention checkpoints.
     * @returns An immutable metrics snapshot.
     */
    metricsSnapshot(): Readonly<RealtimeEventPumpMetrics> {
        return this.#state.metricsSnapshot();
    }

    /** Records one store-backed poll failure observed by the Effect runner. */
    recordPollFailure(): void {
        this.#state.pollFailures += 1;
    }

    /** Records one retry decision made by the Effect retry schedule. */
    recordRetryablePollRetry(): void {
        this.#state.retryablePollRetries += 1;
    }

    /** Records one subscription read retry decision made by the Effect schedule. */
    recordRetryableSubscriptionReadRetry(): void {
        this.#state.retryableSubscriptionReadRetries += 1;
    }

    /** Records one failed store read performed while opening or replaying a subscription. */
    recordSubscriptionReadFailure(): void {
        this.#state.subscriptionReadFailures += 1;
    }

    /** Terminates all current subscribers with a classified operational failure. */
    failSubscribers(error: Error): void {
        this.#state.failSubscribers(error);
    }

    /**
     * Replays durable rows through a stable boundary, then follows the central live poll.
     * @param options Canonical cursor, request abort signal, and optional topic filter.
     * Topic filters must already be authorized by the transport adapter before subscription.
     * @returns An async generator of ordered changes or one terminal resync-required
     * control delivery.
     */
    subscribe(
        options: RealtimeEventSubscriptionOptions
    ): AsyncGenerator<RealtimeEventDelivery> {
        return subscribeRealtimeEvents(this.#state, options);
    }

    /**
     * Performs one synchronous, bounded poll step for the scoped Effect runner.
     * @returns The next adaptive polling action.
     */
    poll(): RealtimeEventPollPlan {
        return pollRealtimeEvents(this.#state);
    }
}
