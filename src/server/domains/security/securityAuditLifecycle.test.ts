import { describe, expect, test } from "bun:test";

import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import { createSqliteLogMaintenanceAuditWriter } from "../logs/operationAudit.ts";
import { createSecurityAuditEvent } from "./audit.ts";
import { createSecurityAuditLifecycleService } from "./securityAuditLifecycle.ts";
import { createSecurityAuditLifecycleRepository } from "./securityAuditLifecycleRepository.ts";
import { DrizzleSecurityAuditStore } from "./securityAuditStore.ts";
import {
    bootstrapAuthenticationLifecycle,
    createAuthenticationLifecycleHarness,
} from "./testSupport/authenticationLifecycle.ts";

const firstSameTimeId = "019fc968-1a9b-7771-8f1b-d5b863b0e7b4";
const secondSameTimeId = "019fc968-1a9b-7772-8f1b-d5b863b0e7b4";
const oldestId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
const now = new Date("2026-08-05T09:00:00.000Z");

describe("security audit lifecycle", () => {
    test("lists redacted events with stable keyset pagination", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const store = new DrizzleSecurityAuditStore(harness.database.orm);
            const actor = {
                authenticatorId: created.session.id,
                id: created.user.id,
                kind: "user" as const,
            };
            for (const input of [
                {
                    id: firstSameTimeId,
                    occurredAt: new Date("2026-08-05T08:59:00.000Z"),
                },
                {
                    id: secondSameTimeId,
                    occurredAt: new Date("2026-08-05T08:59:00.000Z"),
                },
                {
                    id: oldestId,
                    occurredAt: new Date("2026-08-05T08:58:00.000Z"),
                },
            ]) {
                store.insertAuditEvent(
                    createSecurityAuditEvent({
                        action: "auth.session.revoke-others",
                        actor,
                        id: input.id,
                        metadata: {
                            revokedSessions: 2,
                            secret: "redacted-before-storage",
                        } as never,
                        occurredAt: input.occurredAt,
                        outcome: "succeeded",
                        requestId: "request-audit-list",
                        targetId: created.user.id,
                        targetType: "auth_sessions",
                    })
                );
            }
            const service = createSecurityAuditLifecycleService({
                now: () => now,
                repository: createSecurityAuditLifecycleRepository(harness.database.orm),
            });
            const identity = {
                sessionId: created.session.id,
                userId: created.user.id,
            };

            const firstPage = service.listEvents(identity, { limit: 2 });
            expect(firstPage.status).toBe("listed");
            if (firstPage.status !== "listed") return;
            expect(firstPage.result.events).toHaveLength(2);
            expect(firstPage.result.events[0]?.action).toBe("auth.bootstrap");
            expect(firstPage.result.events[1]).toMatchObject({
                id: secondSameTimeId,
                metadata: { revokedSessions: 2 },
            });
            expect(JSON.stringify(firstPage.result)).not.toContain(
                "redacted-before-storage"
            );
            expect(firstPage.result.nextCursor).toEqual({
                id: secondSameTimeId,
                occurredAtMs: new Date("2026-08-05T08:59:00.000Z").getTime(),
            });

            const secondPage = service.listEvents(identity, {
                cursor: firstPage.result.nextCursor,
                limit: 2,
            });
            expect(secondPage).toMatchObject({
                result: {
                    events: [{ id: firstSameTimeId }, { id: oldestId }],
                },
                status: "listed",
            });
            if (secondPage.status === "listed") {
                expect(secondPage.result.nextCursor).toBeUndefined();
            }
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("lists a persisted queued log-maintenance audit", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            const occurredAt = new Date("2026-08-05T08:59:30.000Z");
            const auditId = "019fc968-1a9b-7773-8f1b-d5b863b0e7b4";
            const requestId = "request-logs-maintenance";
            const actor = {
                authenticatorId: created.session.id,
                id: created.user.id,
                kind: "user" as const,
            };
            const writer = createSqliteLogMaintenanceAuditWriter({
                clock: () => occurredAt,
                database: harness.database.orm,
                generateId: () => auditId,
                writeAdmission: testImmediateDatabaseWriteAdmission,
            });
            await writer.record({
                actor,
                dryRun: false,
                jobRunId: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
                policyId: "host-rsyslog",
                requestId,
                settlement: "queued",
            });
            const service = createSecurityAuditLifecycleService({
                now: () => now,
                repository: createSecurityAuditLifecycleRepository(harness.database.orm),
            });

            const listed = service.listEvents(
                {
                    sessionId: created.session.id,
                    userId: created.user.id,
                },
                { limit: 20 }
            );

            expect(listed.status).toBe("listed");
            if (listed.status !== "listed") return;
            expect(listed.result.events.find(({ id }) => id === auditId)).toEqual({
                action: "logs.maintenance.request",
                actor,
                id: auditId,
                metadata: { settlement: "succeeded" },
                occurredAtMs: occurredAt.getTime(),
                outcome: "succeeded",
                requestId,
                target: {
                    id: "019fc968-1a9b-7770-8f1b-d5b863b0e7b5",
                    type: "job-run",
                },
            });
        } finally {
            harness.database.sqlite.close(true);
        }
    });

    test("fails closed before a cursor can bypass future or unclassified history", async () => {
        for (const defect of ["future", "metadata"] as const) {
            const harness = await createAuthenticationLifecycleHarness();

            try {
                const created = await bootstrapAuthenticationLifecycle(harness);
                if (defect === "future") {
                    new DrizzleSecurityAuditStore(harness.database.orm).insertAuditEvent(
                        createSecurityAuditEvent({
                            action: "auth.logout",
                            actor: {
                                authenticatorId: created.session.id,
                                id: created.user.id,
                                kind: "user",
                            },
                            id: Bun.randomUUIDv7(),
                            occurredAt: new Date("2026-08-05T09:00:01.000Z"),
                            outcome: "succeeded",
                            targetId: created.session.id,
                            targetType: "auth_session",
                        })
                    );
                } else {
                    harness.database.sqlite.run(
                        "INSERT INTO audit_events (action, actor_id, actor_kind, authenticator_id, id, metadata_json, occurred_at, outcome, request_id, target_id, target_type) VALUES (?, ?, 'user', ?, ?, ?, ?, 'succeeded', NULL, ?, 'auth_session')",
                        [
                            "auth.logout",
                            created.user.id,
                            created.session.id,
                            Bun.randomUUIDv7(),
                            JSON.stringify({ credential: "must-not-escape" }),
                            new Date("2026-08-05T08:59:00.000Z").getTime(),
                            created.session.id,
                        ]
                    );
                }
                const service = createSecurityAuditLifecycleService({
                    now: () => now,
                    repository: createSecurityAuditLifecycleRepository(
                        harness.database.orm
                    ),
                });

                expect(() =>
                    service.listEvents(
                        {
                            sessionId: created.session.id,
                            userId: created.user.id,
                        },
                        { limit: 20 }
                    )
                ).toThrow();
            } finally {
                harness.database.sqlite.close(true);
            }
        }
    });

    test("returns session-changed without exposing history for a stale actor", async () => {
        const harness = await createAuthenticationLifecycleHarness();

        try {
            const created = await bootstrapAuthenticationLifecycle(harness);
            harness.database.sqlite.run("DELETE FROM auth_sessions WHERE id = ?", [
                created.session.id,
            ]);
            const service = createSecurityAuditLifecycleService({
                now: () => now,
                repository: createSecurityAuditLifecycleRepository(harness.database.orm),
            });

            expect(
                service.listEvents(
                    {
                        sessionId: created.session.id,
                        userId: created.user.id,
                    },
                    { limit: 20 }
                )
            ).toEqual({ status: "session-changed" });
        } finally {
            harness.database.sqlite.close(true);
        }
    });
});
