import { describe, expect, test } from "bun:test";

import { asc } from "drizzle-orm";

import { auditEvents as storedAuditEvents } from "../../database/schema/auditEvents.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";
import { ServiceActionQueueError } from "../jobs/serviceActionQueue.ts";
import {
    createServiceActionsService,
    createSqliteServiceActionAuditWriter,
    type ServiceActionAuditEvent,
    ServiceActionsServiceError,
} from "./service.ts";

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
                const authorizeEnqueue = await request.authorizeDispatch();
                authorizeEnqueue();
                return queuedResult;
            },
        },
        statusReader: options.statuses ?? {
            read: () =>
                Promise.resolve([
                    { availability: "available", id: "dashboard-restart" },
                    { availability: "available", id: "openclaw-cleanup" },
                    { availability: "available", id: "openclaw-restart" },
                    { availability: "available", id: "openclaw-update" },
                    { availability: "unavailable", id: "system-cleanup" },
                    { availability: "unavailable", id: "system-restart" },
                    {
                        activeRun: queuedRun(jobRunId),
                        availability: "available",
                        id: "system-update",
                    },
                    { availability: "available", id: "worker-restart" },
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
    test("persists only fixed action, run identity, and classified settlement", async () => {
        const database = await openFreshMigratedDatabase();
        const ids = [
            "019ff1c6-1a9b-7775-8f1b-d5b863b0e7a1",
            "019ff1c6-1a9b-7775-8f1b-d5b863b0e7a2",
        ];
        const writer = createSqliteServiceActionAuditWriter({
            clock: () => new Date(1000),
            database: database.orm,
            generateId: () => {
                const id = ids.shift();
                if (id === undefined) throw new Error("Audit id budget exhausted");
                return id;
            },
            writeAdmission: testImmediateDatabaseWriteAdmission,
        });
        const context = {
            actionId: "system-update",
            actor,
            requestId: "request-1",
        } as const;

        try {
            await writer.record({ ...context, settlement: "attempted" });
            await writer.record({ ...context, jobRunId, settlement: "succeeded" });
            const rows = database.orm
                .select()
                .from(storedAuditEvents)
                .orderBy(asc(storedAuditEvents.id))
                .all();
            expect(rows).toMatchObject([
                {
                    action: "service-actions.system-update.request",
                    metadataJson: '{"settlement":"attempted"}',
                    outcome: "attempted",
                    requestId: "request-1",
                    targetId: "system-update",
                    targetType: "service-action",
                },
                {
                    action: "service-actions.system-update.request",
                    metadataJson: '{"settlement":"succeeded"}',
                    outcome: "succeeded",
                    targetId: jobRunId,
                    targetType: "job-run",
                },
            ]);
            expect(JSON.stringify(rows)).not.toContain("apt-get");
        } finally {
            database.sqlite.close(true);
        }
    });
    test("projects the exact bounded status inventory", async () => {
        const result = await fixture().service.getStatus();
        expect(result).toMatchObject({
            actions: [
                { availability: "available", id: "dashboard-restart" },
                { availability: "available", id: "openclaw-cleanup" },
                { availability: "available", id: "openclaw-restart" },
                { availability: "available", id: "openclaw-update" },
                { availability: "unavailable", id: "system-cleanup" },
                { availability: "unavailable", id: "system-restart" },
                {
                    activeRun: { id: jobRunId, state: "queued" },
                    availability: "available",
                    id: "system-update",
                },
                { availability: "available", id: "worker-restart" },
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
                    const authorizeEnqueue = await request.authorizeDispatch();
                    order.push("queue:admitted");
                    authorizeEnqueue();
                    order.push("queue:enqueue");
                    return queuedResult;
                },
            },
            statusReader: {
                read: () =>
                    Promise.resolve([
                        { availability: "available", id: "openclaw-cleanup" },
                        { availability: "available", id: "openclaw-restart" },
                        { availability: "available", id: "openclaw-update" },
                        { availability: "available", id: "system-cleanup" },
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
            "queue:admitted",
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
                    const authorizeEnqueue = await request.authorizeDispatch();
                    authorizeEnqueue();
                    durableEnqueue = true;
                    return queuedResult;
                },
            },
            statuses: {
                read: () =>
                    Promise.resolve([
                        { availability: "available", id: "openclaw-cleanup" },
                        { availability: "available", id: "openclaw-restart" },
                        { availability: "available", id: "openclaw-update" },
                        { availability: "available", id: "system-cleanup" },
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
                    const authorizeEnqueue = await request.authorizeDispatch();
                    try {
                        authorizeEnqueue();
                    } catch {
                        // Deliberately emulate a queue bug swallowing the rejection.
                    }
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

    test("preserves a classified service failure raised during dispatch preflight", async () => {
        const classifiedFailure = new ServiceActionsServiceError("unknown-outcome");
        const state = fixture({
            queue: {
                enqueue: async (request) => {
                    await request.authorizeDispatch();
                    throw new Error("authorizeDispatch should have rejected");
                },
            },
            statuses: {
                read: () => Promise.reject(classifiedFailure),
            },
        });

        const failure = await captureFailure(() =>
            state.service.request(input, state.context)
        );
        expect(failure).toBe(classifiedFailure);
        expect(state.auditEvents.map(({ settlement }) => settlement)).toEqual([
            "attempted",
            "partial",
        ]);
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
