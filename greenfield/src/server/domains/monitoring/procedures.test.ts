import { describe, expect, test } from "bun:test";

import { TRPCError } from "@trpc/server";
import { maxTime } from "date-fns/constants";
import { Effect } from "effect";
import * as v from "valibot";

import { completeMonitoringSnapshotInputSchema } from "../../../contracts/monitoring.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { captureFailure } from "../../test/support/promise.ts";
import {
    createTestApplicationRuntime,
    createTestAutomationAuthentication,
    createTestRequestContext,
    createTestSessionAuthentication,
} from "../../test/support/requestContext.ts";
import { appRouter } from "../../trpc/appRouter.ts";
import { MonitoringCatalogPreconditionError } from "./catalogErrors.ts";
import { createMonitoringCatalogService } from "./catalogService.ts";
import { createMonitoringRepository } from "./repository.ts";
import { createMonitoringService } from "./service.ts";
import {
    oneDayMs,
    openFreshMigratedDatabase,
    snapshot,
    uuid,
} from "./testSupport/monitoringService.ts";
import { createTestMonitoringCatalogService } from "./testSupport/services.ts";

type FreshDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

function monitoringServicesFor(database: FreshDatabase) {
    const repository = createMonitoringRepository(
        database.orm,
        testImmediateDatabaseWriteAdmission
    );
    let nextId = 10_000;
    return {
        monitoringCatalogService: createMonitoringCatalogService({
            nowMs: () => 10_000,
            realtimeRetentionMs: oneDayMs,
            repository,
        }),
        monitoringService: createMonitoringService({
            generateId: () => uuid(nextId++),
            nowMs: () => 10_000,
            realtimeRetentionMs: oneDayMs,
            repository,
        }),
    };
}

function parsedSnapshot(input: ReturnType<typeof snapshot>) {
    return v.parse(completeMonitoringSnapshotInputSchema, input);
}

async function expectTrpcCode(
    operation: () => Promise<unknown>,
    code: TRPCError["code"]
): Promise<void> {
    const failure = await captureFailure(operation);
    expect(failure).toBeInstanceOf(TRPCError);
    expect((failure as TRPCError).code).toBe(code);
}

describe("monitoring procedures", () => {
    test("enforces exact capabilities and principal kinds before service access", async () => {
        const validSnapshot = parsedSnapshot(snapshot({ completedAtMs: 1000, run: 1 }));
        const anonymous = appRouter.createCaller(await createTestRequestContext());
        await expectTrpcCode(
            () => anonymous.incidents.list({ limit: 10 }),
            "UNAUTHORIZED"
        );

        const wrongReadCapability = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["notifications:read"])
            )
        );
        await expectTrpcCode(
            () => wrongReadCapability.reports.list({ limit: 10 }),
            "FORBIDDEN"
        );

        const sessionProducer = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication([
                    "monitoring:write",
                    "notifications:write",
                ])
            )
        );
        await expectTrpcCode(
            () => sessionProducer.monitoring.submitCompleteSnapshot(validSnapshot),
            "FORBIDDEN"
        );
        await expectTrpcCode(
            () =>
                sessionProducer.notifications.upsert({
                    id: uuid(100),
                    kind: "test",
                    message: "Session must not produce notifications",
                    occurredAtMs: 1000,
                    severity: "info",
                    title: "Forbidden producer",
                }),
            "FORBIDDEN"
        );

        const automationAcknowledgement = appRouter.createCaller(
            await createTestRequestContext(
                createTestAutomationAuthentication(["notifications:write"])
            )
        );
        await expectTrpcCode(
            () => automationAcknowledgement.notifications.markAllRead({}),
            "FORBIDDEN"
        );
    });

    test("routes ingestion into readable catalogs and session notification actions", async () => {
        const database = await openFreshMigratedDatabase();
        const services = monitoringServicesFor(database);
        try {
            const producer = appRouter.createCaller(
                await createTestRequestContext(
                    createTestAutomationAuthentication(["monitoring:write"]),
                    createTestApplicationRuntime(),
                    services
                )
            );
            const submission = await producer.monitoring.submitCompleteSnapshot(
                parsedSnapshot(snapshot({ completedAtMs: 1000, run: 10 }))
            );
            expect(submission).toMatchObject({
                createdIncidents: 1,
                observedIncidents: 1,
                status: "accepted",
            });

            const session = appRouter.createCaller(
                await createTestRequestContext(
                    createTestSessionAuthentication([
                        "notifications:read",
                        "notifications:write",
                        "reports:read",
                    ]),
                    createTestApplicationRuntime(),
                    services
                )
            );
            const reports = await session.reports.list({ limit: 10 });
            expect(reports.reports).toHaveLength(1);
            expect(
                await session.reports.get({ id: reports.reports[0]!.id })
            ).toMatchObject({
                bodyMarkdown: "# Health at 1000",
                id: submission.reportId,
            });

            const incidents = await session.incidents.list({ limit: 10 });
            expect(incidents.incidents).toHaveLength(1);
            expect(
                await session.incidents.get({ id: incidents.incidents[0]!.id })
            ).toMatchObject({ state: "active" });

            const notifications = await session.notifications.list({ limit: 10 });
            expect(notifications).toMatchObject({ unreadCount: 1 });
            const markedRead = await session.notifications.markRead({
                id: notifications.notifications[0]!.id,
            });
            expect(markedRead.readAtMs).toBe(10_000);
            expect(await session.notifications.clearRead({ filters: {} })).toMatchObject({
                affectedCount: 1,
                remaining: false,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("maps ingestion conflicts, validation failures, and missing catalog links", async () => {
        const database = await openFreshMigratedDatabase();
        const services = monitoringServicesFor(database);
        try {
            const producer = appRouter.createCaller(
                await createTestRequestContext(
                    createTestAutomationAuthentication([
                        "monitoring:write",
                        "notifications:write",
                    ]),
                    createTestApplicationRuntime(),
                    services
                )
            );
            const initial = parsedSnapshot(snapshot({ completedAtMs: 1000, run: 20 }));
            await producer.monitoring.submitCompleteSnapshot(initial);
            await expectTrpcCode(
                () =>
                    producer.monitoring.submitCompleteSnapshot(
                        v.parse(completeMonitoringSnapshotInputSchema, {
                            ...initial,
                            report: { ...initial.report, title: "Conflicting replay" },
                        })
                    ),
                "CONFLICT"
            );
            await expectTrpcCode(
                () =>
                    producer.monitoring.submitCompleteSnapshot(
                        parsedSnapshot(snapshot({ completedAtMs: 310_001, run: 21 }))
                    ),
                "BAD_REQUEST"
            );
            await expectTrpcCode(
                () =>
                    producer.notifications.upsert({
                        id: uuid(200),
                        kind: "test",
                        message: "References a missing report",
                        occurredAtMs: 2000,
                        reportId: uuid(999_999),
                        severity: "warning",
                        title: "Missing report",
                    }),
                "NOT_FOUND"
            );

            const reader = appRouter.createCaller(
                await createTestRequestContext(
                    createTestSessionAuthentication(["reports:read"]),
                    createTestApplicationRuntime(),
                    services
                )
            );
            await expectTrpcCode(
                () => reader.reports.get({ id: uuid(999_998) }),
                "NOT_FOUND"
            );
        } finally {
            database.sqlite.close(true);
        }
    });

    test("maps retention-overflowing producer timestamps to BAD_REQUEST", async () => {
        const database = await openFreshMigratedDatabase();
        const services = monitoringServicesFor(database);
        try {
            const producer = appRouter.createCaller(
                await createTestRequestContext(
                    createTestAutomationAuthentication([
                        "notifications:write",
                        "reports:write",
                    ]),
                    createTestApplicationRuntime(),
                    services
                )
            );

            await expectTrpcCode(
                () =>
                    producer.reports.upsert({
                        bodyMarkdown: "# Outside retention",
                        id: uuid(210),
                        kind: "health",
                        metadata: {},
                        occurredAtMs: maxTime,
                        source: "dashboard",
                        status: "ok",
                        title: "Outside retention",
                    }),
                "BAD_REQUEST"
            );
            await expectTrpcCode(
                () =>
                    producer.notifications.upsert({
                        id: uuid(211),
                        kind: "health",
                        message: "Outside retention",
                        occurredAtMs: maxTime,
                        severity: "warning",
                        title: "Outside retention",
                    }),
                "BAD_REQUEST"
            );
        } finally {
            database.sqlite.close(true);
        }
    });

    test("maps bounded report deletion refusal to PRECONDITION_FAILED", async () => {
        const reportId = uuid(300);
        const monitoringCatalogService = createTestMonitoringCatalogService({
            deleteReport: () =>
                Effect.fail(
                    new MonitoringCatalogPreconditionError({
                        id: reportId,
                        linkedNotificationCount: 101,
                        maximumLinkedNotifications: 100,
                        resource: "report",
                    })
                ),
        });
        const caller = appRouter.createCaller(
            await createTestRequestContext(
                createTestSessionAuthentication(["reports:write"]),
                createTestApplicationRuntime(),
                { monitoringCatalogService }
            )
        );

        await expectTrpcCode(
            () => caller.reports.delete({ id: reportId }),
            "PRECONDITION_FAILED"
        );
    });
});
