/* oxlint-disable typescript/require-await -- Async test doubles mirror production promise ports. */
import { describe, expect, test } from "bun:test";

import type {
    ChatEventSubscriptionRequest,
    ChatProviderRunWatermark,
} from "./provider.ts";
import {
    ChatSessionSubscriptionManager,
    ChatSubscriptionCapacityError,
} from "./subscriptionManager.ts";

function managerHarness(
    options: {
        idleMilliseconds?: number;
        maximum?: number;
        pinned?: boolean;
    } = {}
) {
    let nowMs = 1000;
    let pinned = options.pinned ?? false;
    let watermark = 0;
    let closes = 0;
    let events = 0;
    let gaps = 0;
    let reconciliations = 0;
    const requests: ChatEventSubscriptionRequest[] = [];
    const manager = new ChatSessionSubscriptionManager({
        ...(options.idleMilliseconds === undefined
            ? {}
            : { idleMilliseconds: options.idleMilliseconds }),
        isPinned: () => pinned,
        ...(options.maximum === undefined ? {} : { maximum: options.maximum }),
        nowMs: () => nowMs,
        onEvent: () => {
            events += 1;
        },
        onGap: () => {
            gaps += 1;
        },
        onReconciliationRequired: () => {
            reconciliations += 1;
        },
        provider: {
            subscribeChat: async (request) => {
                requests.push(request);
                return {
                    close: async () => {
                        closes += 1;
                    },
                };
            },
        },
        watermarks: (sessionKey): readonly ChatProviderRunWatermark[] =>
            watermark === 0
                ? []
                : [
                      {
                          lastProviderSequence: watermark,
                          providerRunId: `${sessionKey}:run`,
                      },
                  ],
    });
    return {
        get closes() {
            return closes;
        },
        get events() {
            return events;
        },
        get gaps() {
            return gaps;
        },
        manager,
        get reconciliations() {
            return reconciliations;
        },
        requests,
        setNow(value: number) {
            nowMs = value;
        },
        setPinned(value: boolean) {
            pinned = value;
        },
        setWatermark(value: number) {
            watermark = value;
        },
    };
}

describe("ChatSessionSubscriptionManager", () => {
    test("maps projected legacy main sessions to the implicit main owner", async () => {
        const harness = managerHarness();
        await harness.manager.touch("main");
        await harness.manager.touch("global");
        expect(harness.requests).toEqual([
            expect.objectContaining({ agentId: "main", sessionKey: "main" }),
            expect.objectContaining({ agentId: "main", sessionKey: "global" }),
        ]);
    });

    test("shares one lease, retains pinned work, and sweeps idle unpinned leases", async () => {
        const harness = managerHarness({ idleMilliseconds: 100 });
        await harness.manager.touch("agent:main:main");
        await harness.manager.touch("agent:main:main");
        expect(harness.requests).toHaveLength(1);
        expect(harness.requests[0]).toMatchObject({
            agentId: "main",
            sessionKey: "agent:main:main",
        });

        harness.setPinned(true);
        harness.setNow(1200);
        expect(await harness.manager.sweep()).toBe(0);
        harness.setPinned(false);
        expect(await harness.manager.sweep()).toBe(1);
        expect(harness.closes).toBe(1);
        expect(harness.manager.size).toBe(0);
    });

    test("enforces process capacity until an idle selected session is swept", async () => {
        const harness = managerHarness({ idleMilliseconds: 100, maximum: 1 });
        await harness.manager.touch("agent:main:first");
        expect(harness.manager.touch("agent:main:second")).rejects.toBeInstanceOf(
            ChatSubscriptionCapacityError
        );
        harness.setNow(1200);
        await harness.manager.touch("agent:main:second");
        expect(
            harness.requests.map(({ agentId, sessionKey }) => ({ agentId, sessionKey }))
        ).toEqual([
            { agentId: "main", sessionKey: "agent:main:first" },
            { agentId: "main", sessionKey: "agent:main:second" },
        ]);
    });

    test("keeps recoverable gaps live and rotates terminal boundaries with current watermarks", async () => {
        const harness = managerHarness({ pinned: true });
        await harness.manager.touch("agent:main:main");
        harness.setWatermark(1);
        await harness.requests.at(-1)!.onGap({
            expectedSequence: 1,
            providerRunId: "provider-run",
            receivedSequence: 2,
            sessionKey: "agent:main:main",
        });
        expect(harness.requests).toHaveLength(1);
        expect(harness.closes).toBe(0);

        for (const [index, reason] of (
            ["backpressure", "transport", "subscription"] as const
        ).entries()) {
            harness.setWatermark(index + 2);
            await harness.requests.at(-1)!.onReconciliationRequired(reason);
            expect(harness.requests).toHaveLength(index + 2);
            expect(harness.requests.at(-1)!.runWatermarks[0]!.lastProviderSequence).toBe(
                index + 2
            );
        }
        expect(harness.closes).toBe(3);
        await harness.manager.dispose();
        expect(harness.closes).toBe(4);
    });

    test("an unpinned dead lease is reacquired on the next touch", async () => {
        const harness = managerHarness();
        await harness.manager.touch("agent:main:main");
        await harness.requests[0]!.onReconciliationRequired("transport");
        expect(harness.manager.size).toBe(0);
        harness.setWatermark(7);
        await harness.manager.touch("agent:main:main");
        expect(harness.requests).toHaveLength(2);
        expect(harness.requests[1]!.runWatermarks[0]!.lastProviderSequence).toBe(7);
    });

    test("retains a recoverable gap lease but never a failed terminal lease", async () => {
        const requests: ChatEventSubscriptionRequest[] = [];
        let closes = 0;
        const manager = new ChatSessionSubscriptionManager({
            isPinned: () => true,
            onEvent: () => {},
            onGap: () => Promise.reject(new Error("history unavailable")),
            onReconciliationRequired: () =>
                Promise.reject(new Error("history unavailable")),
            provider: {
                subscribeChat: async (request) => {
                    requests.push(request);
                    return {
                        close: async () => {
                            closes += 1;
                        },
                    };
                },
            },
            watermarks: () => [],
        });

        await manager.touch("agent:main:main");
        const reconciliationFailure = await Promise.resolve(
            requests[0]!.onReconciliationRequired("transport")
        ).then(
            () => null,
            (error: unknown) => error
        );
        expect(reconciliationFailure).toEqual(new Error("history unavailable"));
        expect(requests).toHaveLength(2);
        expect(closes).toBe(1);

        const gapFailure = await Promise.resolve(
            requests[1]!.onGap({
                expectedSequence: 1,
                providerRunId: "provider-run",
                receivedSequence: 2,
                sessionKey: "agent:main:main",
            })
        ).then(
            () => null,
            (error: unknown) => error
        );
        expect(gapFailure).toEqual(new Error("history unavailable"));
        expect(requests).toHaveLength(2);
        expect(closes).toBe(1);
    });

    test("drops every callback from an invalidated transcript lease", async () => {
        const harness = managerHarness({ pinned: true });
        await harness.manager.touch("agent:main:main");
        const retired = harness.requests[0]!;
        expect(await harness.manager.invalidate("agent:main:main")).toBeTrue();

        await retired.onEvent({
            kind: "terminal",
            outcome: "completed",
            providerRunId: "provider-before-reset",
            providerSequence: 1,
            receivedAtMs: 1200,
            sessionKey: "agent:main:main",
        });
        await retired.onGap({
            expectedSequence: 2,
            providerRunId: "provider-before-reset",
            receivedSequence: 3,
            sessionKey: "agent:main:main",
        });
        await retired.onReconciliationRequired("transport");

        expect(harness.events).toBe(0);
        expect(harness.gaps).toBe(0);
        expect(harness.reconciliations).toBe(0);
        expect(harness.requests).toHaveLength(1);

        await harness.manager.touch("agent:main:main");
        await harness.requests[1]!.onEvent({
            kind: "terminal",
            outcome: "completed",
            providerRunId: "provider-after-reset",
            providerSequence: 1,
            receivedAtMs: 1300,
            sessionKey: "agent:main:main",
        });
        expect(harness.events).toBe(1);
    });
});
