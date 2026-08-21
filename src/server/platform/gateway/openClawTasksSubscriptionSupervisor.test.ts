import { describe, expect, test } from "bun:test";

import type { OpenClawTaskProviderSubscription } from "../../domains/openClawTasks/provider.ts";
import { createOpenClawTasksSubscriptionSupervisor } from "./openClawTasksSubscriptionSupervisor.ts";

async function flush(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("OpenClaw tasks subscription supervisor", () => {
    test("retries a terminal durable-bridge failure and closes the replacement", async () => {
        const timers: Array<() => void> = [];
        const delays: number[] = [];
        const failures: unknown[] = [];
        const first = Promise.withResolvers<void>();
        const second = Promise.withResolvers<void>();
        const third = Promise.withResolvers<void>();
        let subscriptions = 0;
        let replacementClosed = 0;
        const service = {
            subscribe: (): Promise<OpenClawTaskProviderSubscription> => {
                subscriptions += 1;
                if (subscriptions === 1) {
                    return Promise.resolve({
                        close: () => {
                            first.resolve();
                            return Promise.resolve();
                        },
                        done: first.promise,
                    });
                }
                if (subscriptions === 2) {
                    return Promise.resolve({
                        close: () => {
                            second.resolve();
                            return Promise.resolve();
                        },
                        done: second.promise,
                    });
                }
                return Promise.resolve({
                    close: () => {
                        replacementClosed += 1;
                        third.resolve();
                        return Promise.resolve();
                    },
                    done: third.promise,
                });
            },
        };
        const supervisor = createOpenClawTasksSubscriptionSupervisor({
            minimumRetryDelayMs: 10,
            onFailure: (error) => failures.push(error),
            scheduler: {
                clearTimeout: () => {},
                setTimeout: (callback, delayMs) => {
                    timers.push(callback);
                    delays.push(delayMs);
                    return callback;
                },
            },
            service,
        });

        supervisor.start();
        await flush();
        expect(subscriptions).toBe(1);
        first.reject(new Error("durable outbox unavailable"));
        await flush();
        expect(failures).toHaveLength(1);
        expect(timers).toHaveLength(1);

        timers.shift()?.();
        await flush();
        expect(subscriptions).toBe(2);
        second.reject(new Error("durable outbox unavailable again"));
        await flush();
        expect(failures).toHaveLength(2);
        expect(delays).toEqual([10, 20]);

        timers.shift()?.();
        await flush();
        expect(subscriptions).toBe(3);
        await supervisor.stop();
        expect(replacementClosed).toBe(1);
    });
});
