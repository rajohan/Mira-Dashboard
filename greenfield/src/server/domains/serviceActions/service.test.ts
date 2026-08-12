import { describe, expect, test } from "bun:test";

import { ServiceActionQueueError } from "../jobs/serviceActionQueue.ts";
import type { ServiceActionAuditEvent } from "./operationAudit.ts";
import { createServiceActionsService, ServiceActionsServiceError } from "./service.ts";

const actor = Object.freeze({
    authenticatorId: "a".repeat(32),
    id: "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b4",
    kind: "user" as const,
});
const jobRunId = "019ff1c6-1a9b-7770-8f1b-d5b863b0e7b5";
const input = Object.freeze({
    actionId: "system-update" as const,
    confirmation: "update-system" as const,
    idempotencyKey: "A".repeat(43),
});
const queuedResult = Object.freeze({
    actionId: input.actionId,
    jobRunId,
    queued: true as const,
});

function queuedRun(id: string) {
    return {
        actionKey: "host.system.update",
        attemptCount: 0,
        attemptLimit: 1,
        availableAtMs: 1000,
        cancellationPolicy: "never" as const,
        displayName: "Update host system",
        eventCount: 1,
        id,
        priority: 20,
        queuedAtMs: 1000,
        resourceClass: "exclusive" as const,
        resourceKeys: ["host.mutation"],
        retrySafe: false,
        state: "queued" as const,
        stateVersion: 1,
        timeoutMs: 7_200_000,
        triggerType: "manual" as const,
        updatedAtMs: 1000,
    };
}

function fixture(
    options: {
        readonly auditFailure?: "attempted" | "failed" | "partial" | "succeeded";
        readonly queue?: Parameters<typeof createServiceActionsService>[0]["queue"];
        readonly statuses?: Parameters<
            typeof createServiceActionsService
        >[0]["statusReader"];
    } = {}
) {
    const auditEvents: ServiceActionAuditEvent[] = [];
    const settlementFailures: string[] = [];
    let reauthorizations = 0;
    const service = createServiceActionsService({
        auditWriter: {
            record: (event) => {
                if (event.settlement === options.auditFailure) {
                    return Promise.reject(new Error("private audit failure"));
                }
                auditEvents.push(event);
                return Promise.resolve();
            },
        },
        nowMs: () => 2000,
        onAuditSettlementFailure: ({ settlement }) => {
            settlementFailures.push(settlement);
        },
        queue: options.queue ?? {
            enqueue: async (request) => {
                await request.authorizeDispatch();
                return queuedResult;
            },
        },
        statusReader: options.statuses ?? {
            read: () =>
                Promise.resolve([
                    { availability: "available", id: "openclaw-cleanup" },
                    { availability: "available", id: "openclaw-update" },
                    { availability: "unavailable", id: "system-restart" },
                    {
                        activeRun: queuedRun(jobRunId),
                        availability: "available",
                        id: "system-update",
                    },
                ]),
        },
    });
    return {
        auditEvents,
        context: {
            actor,
            reauthorize: () => {
                reauthorizations += 1;
            },
            requestId: "request-1",
        },
        reauthorizations: () => reauthorizations,
        service,
        settlementFailures,
    };
}

async function captureFailure(work: () => Promise<unknown>): Promise<unknown> {
    try {
        await work();
    } catch (error) {
        return error;
    }
    throw new Error("Expected work to fail");
}

describe("service actions service", () => {
    test("projects the exact bounded status inventory", async () => {
        const result = await fixture().service.getStatus();
        expect(result).toMatchObject({
            actions: [
                { availability: "available", id: "openclaw-cleanup" },
                { availability: "available", id: "openclaw-update" },
                { availability: "unavailable", id: "system-restart" },
                {
                    activeRun: { id: jobRunId, state: "queued" },
                    availability: "available",
                    id: "system-update",
                },
            ],
            observedAtMs: 2000,
        });
    });

    test("records attempted before reauthorization/enqueue and links the queued run", async () => {
        const order: string[] = [];
        const auditEvents: ServiceActionAuditEvent[] = [];
        const service = createServiceActionsService({
            auditWriter: {
                record: (event) => {
                    order.push(`audit:${event.settlement}`);
                    auditEvents.push(event);
                    return Promise.resolve();
                },
            },
            queue: {
                enqueue: async (request) => {
                    order.push("queue:preflight");
                    await request.authorizeDispatch();
                    order.push("queue:enqueue");
                    return queuedResult;
                },
            },
            statusReader: {
                read: () =>
                    Promise.resolve([
                        { availability: "available", id: "openclaw-cleanup" },
                        { availability: "available", id: "openclaw-update" },
                        { availability: "available", id: "system-restart" },
                        { availability: "available", id: "system-update" },
                    ]),
            },
        });
        const result = await service.request(input, {
            actor,
            reauthorize: () => order.push("authorize"),
            requestId: "request-1",
        });

        expect(result).toEqual({
            actionId: "system-update",
            jobRunId,
            queued: true,
        });
        expect(order).toEqual([
            "audit:attempted",
            "queue:preflight",
            "authorize",
            "queue:enqueue",
            "audit:succeeded",
        ]);
        expect(auditEvents[1]).toMatchObject({ jobRunId, settlement: "succeeded" });
    });

    test("fails closed before queue work when attempted audit fails", async () => {
        let queueCalled = false;
        const state = fixture({
            auditFailure: "attempted",
            queue: {
                enqueue: () => {
                    queueCalled = true;
                    return Promise.resolve(queuedResult);
                },
            },
        });
        expect(
            await captureFailure(() => state.service.request(input, state.context))
        ).toMatchObject({ reason: "audit-unavailable" });
        expect(queueCalled).toBeFalse();
    });

    test("rejects unavailable actions before the final authorization handoff", async () => {
        let durableEnqueue = false;
        const state = fixture({
            queue: {
                enqueue: async (request) => {
                    await request.authorizeDispatch();
                    durableEnqueue = true;
                    return queuedResult;
                },
            },
            statuses: {
                read: () =>
                    Promise.resolve([
                        { availability: "available", id: "openclaw-cleanup" },
                        { availability: "available", id: "openclaw-update" },
                        { availability: "available", id: "system-restart" },
                        { availability: "unavailable", id: "system-update" },
                    ]),
            },
        });

        expect(
            await captureFailure(() => state.service.request(input, state.context))
        ).toMatchObject({ reason: "unavailable" });
        expect(durableEnqueue).toBeFalse();
        expect(state.reauthorizations()).toBe(0);
        expect(state.auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "failed",
        ]);
    });

    test("preserves a reauthorization rejection even when the queue swallows it", async () => {
        const authorizationError = new Error("authorization changed");
        const state = fixture({
            queue: {
                enqueue: async (request) => {
                    await request.authorizeDispatch().catch(() => {});
                    return queuedResult;
                },
            },
        });
        const failure = await captureFailure(() =>
            state.service.request(input, {
                ...state.context,
                reauthorize: () => {
                    throw authorizationError;
                },
            })
        );
        expect(failure).toBe(authorizationError);
        expect(state.auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "failed",
        ]);
    });

    test("classifies unknown queue outcome as partial without leaking its cause", async () => {
        const state = fixture({
            queue: {
                enqueue: () =>
                    Promise.reject(new ServiceActionQueueError("unknown-outcome")),
            },
        });
        const failure = await captureFailure(() =>
            state.service.request(input, state.context)
        );
        expect(failure).toBeInstanceOf(ServiceActionsServiceError);
        expect(failure).toMatchObject({ reason: "unknown-outcome" });
        expect(state.auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "partial",
        ]);
        expect(JSON.stringify(failure)).not.toContain("systemctl");
    });

    test("does not replace a confirmed queued result when settlement audit fails", async () => {
        const state = fixture({ auditFailure: "succeeded" });
        expect(await state.service.request(input, state.context)).toMatchObject({
            jobRunId,
            queued: true,
        });
        expect(state.settlementFailures).toEqual(["succeeded"]);
        expect(state.reauthorizations()).toBe(1);
    });
});
