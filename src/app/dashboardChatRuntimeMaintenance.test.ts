import { describe, expect, test } from "bun:test";

import { startDashboardChatRuntimeMaintenance } from "./dashboardChatRuntimeMaintenance.ts";

async function flush(): Promise<void> {
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("Dashboard chat runtime maintenance", () => {
    test("recovers before scheduling and drains one active sweep during shutdown", async () => {
        const events: string[] = [];
        const sweep = Promise.withResolvers<void>();
        let callback: (() => void) | undefined;
        let subscriptionSweeps = 0;
        const maintenance = await startDashboardChatRuntimeMaintenance({
            intervalMs: 30_000,
            scheduler: {
                clearInterval: () => events.push("interval:clear"),
                setInterval: (next, intervalMs) => {
                    events.push(`interval:set:${String(intervalMs)}`);
                    callback = next;
                    return "fixture-handle";
                },
                unref: () => events.push("interval:unref"),
            },
            service: {
                recover: () => {
                    events.push("recover");
                    return Promise.resolve();
                },
                sweepRetention: async () => {
                    events.push("retention");
                    if (subscriptionSweeps > 0) await sweep.promise;
                    return 0;
                },
                sweepSubscriptions: async () => {
                    subscriptionSweeps += 1;
                    events.push("subscriptions");
                    await sweep.promise;
                    return 0;
                },
            },
        });

        expect(events).toEqual([
            "retention",
            "recover",
            "interval:set:30000",
            "interval:unref",
        ]);
        callback?.();
        callback?.();
        await flush();
        expect(subscriptionSweeps).toBe(1);

        let stopped = false;
        const stopping = maintenance.stop().then(() => {
            stopped = true;
            return stopped;
        });
        await flush();
        expect(stopped).toBe(false);
        expect(events).toContain("interval:clear");

        sweep.resolve();
        await stopping;
        expect(stopped).toBe(true);
        expect(maintenance.stop()).resolves.toBeUndefined();
    });

    test("contains sweep and failure-reporter errors while remaining schedulable", async () => {
        const failures: unknown[] = [];
        let callback: (() => void) | undefined;
        let sweeps = 0;
        const maintenance = await startDashboardChatRuntimeMaintenance({
            intervalMs: 1,
            onFailure: (error) => {
                failures.push(error);
                throw new Error("reporter failed");
            },
            scheduler: {
                clearInterval: () => {},
                setInterval: (next) => {
                    callback = next;
                    return;
                },
            },
            service: {
                recover: () => Promise.resolve(),
                sweepRetention: () => {
                    sweeps += 1;
                    return sweeps > 1
                        ? Promise.reject(new Error("retention failed"))
                        : Promise.resolve(0);
                },
                sweepSubscriptions: () => Promise.resolve(0),
            },
        });

        callback?.();
        await flush();
        callback?.();
        await flush();
        expect(failures).toHaveLength(2);
        await maintenance.stop();
    });

    test("starts maintenance when initial Gateway recovery is unavailable", async () => {
        const failures: unknown[] = [];
        let callback: (() => void) | undefined;
        let recoveries = 0;
        const maintenance = await startDashboardChatRuntimeMaintenance({
            intervalMs: 1,
            onFailure: (error) => failures.push(error),
            scheduler: {
                clearInterval: () => {},
                setInterval: (next) => {
                    callback = next;
                    return;
                },
            },
            service: {
                recover: () => {
                    recoveries += 1;
                    return recoveries === 1
                        ? Promise.reject(new Error("Gateway connecting"))
                        : Promise.resolve();
                },
                sweepRetention: () => Promise.resolve(0),
                sweepSubscriptions: () => Promise.resolve(0),
            },
        });

        expect(failures).toHaveLength(1);
        callback?.();
        await flush();
        expect(recoveries).toBe(2);
        await maintenance.stop();
    });
});
