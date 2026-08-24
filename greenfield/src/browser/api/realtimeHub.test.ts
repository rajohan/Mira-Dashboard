import { describe, expect, test } from "bun:test";

import type {
    RealtimeStreamInput,
    RealtimeStreamOutput,
} from "../../contracts/events.ts";
import { monitoringRealtimeTopics } from "../../contracts/monitoringRealtime.ts";
import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import type {
    DashboardRealtimeClient,
    DashboardRealtimeObserver,
} from "./realtimeClient.ts";
import { createDashboardRealtimeHub } from "./realtimeHub.ts";

interface ControlledSubscription {
    readonly input: RealtimeStreamInput;
    readonly observer: DashboardRealtimeObserver;
    unsubscribeCount: number;
}

class ControlledRealtimeClient implements DashboardRealtimeClient {
    readonly subscriptions: ControlledSubscription[] = [];

    subscribe(input: RealtimeStreamInput, observer: DashboardRealtimeObserver) {
        const subscription: ControlledSubscription = {
            input,
            observer,
            unsubscribeCount: 0,
        };
        this.subscriptions.push(subscription);
        return {
            unsubscribe: () => {
                subscription.unsubscribeCount += 1;
            },
        };
    }
}

function change(
    id: string,
    topic: typeof taskRealtimeTopic | typeof monitoringRealtimeTopics.reports
): RealtimeStreamOutput {
    if (topic === taskRealtimeTopic) {
        return {
            data: {
                event: {
                    entityId: "019fd984-63e8-7404-a7da-80c6f243794f",
                    entityType: "task",
                    occurredAtMs: 1_800_000_000_000,
                    operation: "updated",
                    payload: { id: "019fd984-63e8-7404-a7da-80c6f243794f" },
                    topic,
                },
                kind: "change",
            },
            id,
        };
    }
    return {
        data: {
            event: {
                entityId: "report:daily",
                entityType: "report",
                occurredAtMs: 1_800_000_000_000,
                operation: "created",
                payload: { id: "report:daily" },
                topic,
            },
            kind: "change",
        },
        id,
    };
}

describe("Dashboard realtime hub", () => {
    test("shares one resumable stream and routes only matching topics", () => {
        const client = new ControlledRealtimeClient();
        const hub = createDashboardRealtimeHub(client);
        const taskOutputs: RealtimeStreamOutput[] = [];
        const reportOutputs: RealtimeStreamOutput[] = [];
        const tasks = hub.subscribe([taskRealtimeTopic], {
            onData: (output) => taskOutputs.push(output),
        });
        const first = client.subscriptions[0]!;
        const reports = hub.subscribe([monitoringRealtimeTopics.reports], {
            onData: (output) => reportOutputs.push(output),
        });
        const combined = client.subscriptions[1]!;

        expect(first.unsubscribeCount).toBe(1);
        expect(combined.input).toEqual({
            lastEventId: "0",
            topics: [monitoringRealtimeTopics.reports, taskRealtimeTopic],
        });
        combined.observer.onData(change("11", taskRealtimeTopic));
        combined.observer.onData(change("12", monitoringRealtimeTopics.reports));
        expect(taskOutputs.map(({ id }) => id)).toEqual(["11"]);
        expect(reportOutputs.map(({ id }) => id)).toEqual(["12"]);

        reports.unsubscribe();
        const tasksOnly = client.subscriptions[2]!;
        expect(combined.unsubscribeCount).toBe(1);
        expect(tasksOnly.input).toEqual({
            lastEventId: "12",
            topics: [taskRealtimeTopic],
        });
        tasks.unsubscribe();
        expect(tasksOnly.unsubscribeCount).toBe(1);
        hub.dispose();
    });

    test("broadcasts resync and failures while disposing idempotently", () => {
        const client = new ControlledRealtimeClient();
        const hub = createDashboardRealtimeHub(client);
        const outputs: RealtimeStreamOutput[] = [];
        const failures: Error[] = [];
        hub.subscribe([taskRealtimeTopic], {
            onData: (output) => outputs.push(output),
            onError: (error) => failures.push(error),
        });
        const subscription = client.subscriptions[0]!;
        const resync: RealtimeStreamOutput = {
            data: {
                kind: "resync-required",
                reason: "cursor-outside-retention",
            },
            id: "20",
        };
        const failure = new Error("redacted protocol failure");

        subscription.observer.onData(resync);
        subscription.observer.onError?.(failure);
        expect(outputs).toEqual([resync]);
        expect(failures).toEqual([failure]);
        hub.pause();
        expect(subscription.unsubscribeCount).toBe(1);
        hub.resume();
        expect(client.subscriptions[1]?.input).toEqual({
            lastEventId: "20",
            topics: [taskRealtimeTopic],
        });
        hub.dispose();
        hub.dispose();
        expect(client.subscriptions[1]?.unsubscribeCount).toBe(1);
        expect(() => hub.subscribe([taskRealtimeTopic], { onData: () => {} })).toThrow(
            "Dashboard realtime hub is disposed"
        );
    });
});
