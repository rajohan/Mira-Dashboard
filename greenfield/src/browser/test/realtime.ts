import type {
    DashboardRealtimeClient,
    DashboardRealtimeSubscription,
} from "../api/realtimeClient.ts";

const noOpSubscription: DashboardRealtimeSubscription = Object.freeze({
    unsubscribe() {},
});

/** Realtime dependency for browser tests that do not exercise event delivery. */
export const noOpDashboardRealtimeClient: DashboardRealtimeClient = Object.freeze({
    subscribe: () => noOpSubscription,
});
