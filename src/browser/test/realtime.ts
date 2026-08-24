import type {
    RealtimeStreamInput,
    RealtimeStreamOutput,
} from "../../contracts/events.ts";
import type {
    DashboardRealtimeClient,
    DashboardRealtimeObserver,
    DashboardRealtimeSubscription,
} from "../api/realtimeClient.ts";
import { DashboardProtocolError } from "../api/trpcClient.ts";

const noOpSubscription: DashboardRealtimeSubscription = Object.freeze({
    unsubscribe() {},
});

/** Realtime dependency for browser tests that do not exercise event delivery. */
export const noOpDashboardRealtimeClient: DashboardRealtimeClient = Object.freeze({
    subscribe: () => noOpSubscription,
});

/** Deterministic realtime transport for browser invalidation tests. */
export class ControlledDashboardRealtimeClient implements DashboardRealtimeClient {
    activeSubscriptionCount = 0;
    input: RealtimeStreamInput | undefined;
    observer: DashboardRealtimeObserver | undefined;
    unsubscribeCount = 0;

    subscribe(input: RealtimeStreamInput, observer: DashboardRealtimeObserver) {
        this.input = input;
        this.observer = observer;
        this.activeSubscriptionCount += 1;
        let active = true;
        return {
            unsubscribe: () => {
                if (!active) return;
                active = false;
                this.activeSubscriptionCount -= 1;
                this.unsubscribeCount += 1;
            },
        };
    }

    emit(output: RealtimeStreamOutput): void {
        this.observer?.onData(output);
    }

    fail(): void {
        this.observer?.onError?.(new DashboardProtocolError());
    }

    requireResync(): void {
        this.emit({
            data: {
                kind: "resync-required",
                reason: "cursor-outside-retention",
            },
            id: "20",
        });
    }
}
