import { describe, expect, test } from "bun:test";

import type { RealtimeStreamOutput } from "../../contracts/events.ts";
import { taskRealtimeTopic } from "../../contracts/taskRealtime.ts";
import {
    createDashboardRealtimeClient,
    type DashboardRealtimeTransport,
    type DashboardRealtimeTransportObserver,
} from "./realtimeClient.ts";
import { DashboardProtocolError } from "./trpcClient.ts";

const taskId = "019fd984-63e8-7404-a7da-80c6f243794f";
const taskChange = {
    data: {
        event: {
            entityId: taskId,
            entityType: "task",
            occurredAtMs: 1_800_000_000_000,
            operation: "updated",
            payload: { id: taskId },
            topic: taskRealtimeTopic,
        },
        kind: "change",
    },
    id: "17",
} as const satisfies RealtimeStreamOutput;

class ControlledRealtimeTransport implements DashboardRealtimeTransport {
    input: unknown;
    observer: DashboardRealtimeTransportObserver | undefined;
    path: string | undefined;
    unsubscribeCount = 0;

    subscription(
        path: string,
        input: unknown,
        observer: DashboardRealtimeTransportObserver
    ) {
        this.path = path;
        this.input = input;
        this.observer = observer;
        return {
            unsubscribe: () => {
                this.unsubscribeCount += 1;
            },
        };
    }

    emit(value: unknown): void {
        this.observer?.onData(value);
    }

    fail(error: unknown): void {
        this.observer?.onError(error);
    }
}

describe("Dashboard realtime client", () => {
    test("validates task subscription input and tracked outputs", () => {
        const transport = new ControlledRealtimeTransport();
        const client = createDashboardRealtimeClient(transport);
        const outputs: RealtimeStreamOutput[] = [];
        const subscription = client.subscribe(
            { lastEventId: "0", topics: [taskRealtimeTopic] },
            { onData: (output) => outputs.push(output) }
        );

        expect(transport.path).toBe("events.stream");
        expect(transport.input).toEqual({
            lastEventId: "0",
            topics: [taskRealtimeTopic],
        });
        transport.emit(taskChange);
        expect(outputs).toEqual([taskChange]);
        subscription.unsubscribe();
        subscription.unsubscribe();
        expect(transport.unsubscribeCount).toBe(1);
    });

    test("closes malformed streams and redacts transport failures", () => {
        const malformedTransport = new ControlledRealtimeTransport();
        const failures: DashboardProtocolError[] = [];
        createDashboardRealtimeClient(malformedTransport).subscribe(
            { lastEventId: "0", topics: [taskRealtimeTopic] },
            {
                onData: () => {
                    throw new TypeError("Malformed output reached the application");
                },
                onError: (error) => failures.push(error),
            }
        );
        malformedTransport.emit({ data: { kind: "change" }, id: "private" });
        expect(malformedTransport.unsubscribeCount).toBe(1);
        expect(failures).toEqual([new DashboardProtocolError()]);

        const failedTransport = new ControlledRealtimeTransport();
        createDashboardRealtimeClient(failedTransport).subscribe(
            { lastEventId: "0", topics: [taskRealtimeTopic] },
            { onData: () => {}, onError: (error) => failures.push(error) }
        );
        failedTransport.fail(new Error("private upstream failure"));
        failedTransport.fail(new Error("late private upstream failure"));
        expect(failures.at(-1)).toEqual(new DashboardProtocolError());
        expect(failures).toHaveLength(2);
        expect(failedTransport.unsubscribeCount).toBe(1);
    });
});
