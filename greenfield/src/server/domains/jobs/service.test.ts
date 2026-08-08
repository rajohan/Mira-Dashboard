import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import type { AuthenticatedPrincipal } from "../../../contracts/security.ts";
import { testImmediateDatabaseWriteAdmission } from "../../test/support/databaseWriteAdmission.ts";
import {
    authenticationTestNow,
    authenticationTestUserId,
    openAuthenticationTestDatabase,
} from "../security/testSupport/authentication.ts";
import { JobValidationError } from "./errors.ts";
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
            let snapshotReads = 0;
            let legacyRunReads = 0;
            let legacyEventReads = 0;
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
            };
            const service = createJobService({
                generateId,
                nowMs: serviceNowMs,
                repository: interleavedRepository,
            });

            const detail = await Effect.runPromise(
                service.getRun({ eventLimit: 10, id: queued.id })
            );

            expect(detail.events.map(({ sequence }) => sequence)).toEqual([1]);
            expect(detail.run).toMatchObject({ attemptCount: 0, eventCount: 1 });
            expect({ legacyEventReads, legacyRunReads, snapshotReads }).toEqual({
                legacyEventReads: 0,
                legacyRunReads: 0,
                snapshotReads: 1,
            });
        } finally {
            fixture.database.sqlite.close(true);
        }
    });
});
