import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import {
    authenticationTestNow,
    authenticationTestUserId,
    openAuthenticationTestDatabase,
} from "../security/testSupport/authentication.ts";
import { JobConflictError, JobValidationError } from "./errors.ts";
import type { JobRunEventRecord } from "./records.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";
import { createJobService, reconcileJobSchedules } from "./service.ts";

function createIdGenerator(): () => string {
    let index = 1;
    return () => `019fdf20-0000-7000-8000-${String(index++).padStart(12, "0")}`;
}

const serviceNowMs = () => authenticationTestNow.getTime();

describe("durable jobs service", () => {
    test("preserves an active disable intent across a schedule-only update", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 1,
                        id: "system.worker-smoke",
                        patch: {
                            schedule: {
                                intervalMs: 86_400_000,
                                kind: "interval",
                            },
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobValidationError);
            expect(
                Effect.runPromise(
                    service.updateSchedule(principal, {
                        expectedVersion: 1,
                        id: "system.worker-smoke",
                        patch: {
                            disableIntent: { reason: "Already disabled" },
                            enabled: false,
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobValidationError);
            const unchanged = repository.findSchedule("system.worker-smoke");
            expect(unchanged?.activeDisableIntent).toBeUndefined();
            expect(unchanged?.schedule).toMatchObject({ enabled: false, version: 1 });

            const enabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            expect(enabled.nextRunAtMs).toBe(
                authenticationTestNow.getTime() + 86_400_000
            );
            const disabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 2,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: { reason: "Operator maintenance" },
                        enabled: false,
                    },
                })
            );
            const originalIntent = disabled.activeDisableIntent;
            expect(disabled).toMatchObject({
                enabled: false,
                version: 3,
            });
            expect(disabled.nextRunAtMs).toBeUndefined();
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(enabled.nextRunAtMs!));
            expect(originalIntent).toMatchObject({
                reason: "Operator maintenance",
            });

            const updated = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 3,
                    id: "system.worker-smoke",
                    patch: {
                        schedule: { intervalMs: 120_000, kind: "interval" },
                    },
                })
            );

            expect(updated).toMatchObject({
                activeDisableIntent: originalIntent,
                enabled: false,
                schedule: { intervalMs: 120_000, kind: "interval" },
                version: 4,
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.activeDisableIntent
            ).toMatchObject({
                endedAt: null,
                id: originalIntent?.id,
                reason: "Operator maintenance",
            });
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(authenticationTestNow.getTime() + 120_000));

            const replacement = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 4,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: {
                            expiresAtMs: authenticationTestNow.getTime() + 600_000,
                            reason: "Extended operator maintenance",
                        },
                        enabled: false,
                    },
                })
            );
            expect(replacement).toMatchObject({
                activeDisableIntent: {
                    reason: "Extended operator maintenance",
                },
                enabled: false,
                version: 5,
            });
            expect(replacement.activeDisableIntent?.id).not.toBe(originalIntent?.id);
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("stores the recalculated dormant cursor when cadence changes during disable", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const enabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            const disabled = await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 2,
                    id: "system.worker-smoke",
                    patch: {
                        disableIntent: { reason: "Change cadence during maintenance" },
                        enabled: false,
                        schedule: { intervalMs: 120_000, kind: "interval" },
                    },
                })
            );

            expect(disabled).toMatchObject({
                enabled: false,
                schedule: { intervalMs: 120_000, kind: "interval" },
                version: 3,
            });
            expect(disabled.nextRunAtMs).toBeUndefined();
            expect(enabled.nextRunAtMs).not.toBe(
                authenticationTestNow.getTime() + 120_000
            );
            expect(
                repository.findSchedule("system.worker-smoke")?.schedule.nextRunAt
            ).toEqual(new Date(authenticationTestNow.getTime() + 120_000));
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("maps a never-cancellable queued schedule run to a declared conflict", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({ generateId, nowMs: serviceNowMs, repository });
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            await Effect.runPromise(
                service.updateSchedule(principal, {
                    expectedVersion: 1,
                    id: "system.worker-smoke",
                    patch: { disableIntent: null, enabled: true },
                })
            );
            const runSummary = await Effect.runPromise(
                service.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "1".repeat(32),
                })
            );
            const run = repository.findRun(runSummary.id);
            if (run === undefined) throw new Error("Expected the manual run fixture");
            const conflictRepository: JobRepository = {
                ...repository,
                updateSchedule: () =>
                    Promise.resolve({
                        kind: "cancellation-not-supported",
                        run,
                    }),
            };
            const conflictService = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: conflictRepository,
            });

            expect(
                Effect.runPromise(
                    conflictService.updateSchedule(principal, {
                        expectedVersion: 2,
                        id: "system.worker-smoke",
                        patch: {
                            disableIntent: { reason: "Maintenance" },
                            enabled: false,
                        },
                    })
                )
            ).rejects.toBeInstanceOf(JobConflictError);
            const unchangedSchedule = repository.findSchedule("system.worker-smoke");
            expect(unchangedSchedule?.activeDisableIntent).toBeUndefined();
            expect(unchangedSchedule?.schedule).toMatchObject({
                enabled: true,
                version: 2,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });

    test("reads run and events from one snapshot across an interleaved worker transition", async () => {
        const fixture = await openAuthenticationTestDatabase(authenticationTestNow);
        const repository = createJobRepository(
            fixture.database.orm,
            testImmediateDatabaseWriteAdmission
        );
        const generateId = createIdGenerator();
        const principal: AuthenticatedPrincipal = {
            authorizationVersion: 1,
            authenticatorId: fixture.session.prefix,
            capabilities: ["jobs:read", "jobs:write"],
            id: authenticationTestUserId,
            kind: "session",
        };

        try {
            await reconcileJobSchedules({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const setupService = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository,
            });
            const queued = await Effect.runPromise(
                setupService.runSchedule(principal, {
                    id: "system.worker-smoke",
                    idempotencyKey: "A".repeat(32),
                })
            );
            const snapshot = repository.findRunDetail({
                limit: 10,
                runId: queued.id,
            });
            if (snapshot === undefined) throw new Error("Missing queued run snapshot");

            const interleavedEvent = {
                attempt: 1,
                jobRunId: queued.id,
                kind: "claimed",
                message: null,
                occurredAt: new Date(snapshot.run.updatedAt.getTime() + 1),
                progressJson: null,
                sequence: 2,
                workerInstanceId: "019fdf20-0000-7000-8000-000000000099",
            } satisfies JobRunEventRecord;
            const listSnapshot = repository.listRunsWithQueueState({ limit: 10 });
            let snapshotReads = 0;
            let listSnapshotReads = 0;
            let legacyRunReads = 0;
            let legacyEventReads = 0;
            let legacyListReads = 0;
            let legacyQueueReads = 0;
            const interleavedRepository: JobRepository = {
                ...repository,
                findRun: () => {
                    legacyRunReads += 1;
                    return snapshot.run;
                },
                findRunDetail: () => {
                    snapshotReads += 1;
                    return snapshot;
                },
                listRunEvents: () => {
                    legacyEventReads += 1;
                    return [interleavedEvent, ...snapshot.events];
                },
                listRuns: () => {
                    legacyListReads += 1;
                    return [];
                },
                listRunsWithQueueState: () => {
                    listSnapshotReads += 1;
                    return listSnapshot;
                },
                readQueueState: () => {
                    legacyQueueReads += 1;
                    return listSnapshot.queue;
                },
            };
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: interleavedRepository,
            });

            const detail = await Effect.runPromise(
                service.getRun({ eventLimit: 10, id: queued.id })
            );
            const listing = await Effect.runPromise(service.listRuns({ limit: 10 }));

            expect(detail.events.map(({ sequence }) => sequence)).toEqual([1]);
            expect(detail.run).toMatchObject({ attemptCount: 0, eventCount: 1 });
            expect(listing.runs.map(({ id }) => id)).toEqual([queued.id]);
            expect({
                legacyEventReads,
                legacyListReads,
                legacyQueueReads,
                legacyRunReads,
                listSnapshotReads,
                snapshotReads,
            }).toEqual({
                legacyEventReads: 0,
                legacyListReads: 0,
                legacyQueueReads: 0,
                legacyRunReads: 0,
                listSnapshotReads: 1,
                snapshotReads: 1,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
