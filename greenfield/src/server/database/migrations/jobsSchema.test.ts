import type { SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import { scheduleCronExpressionSchema } from "../../../contracts/jobModel.ts";
import { canonicalScheduleTimeZones } from "../../../contracts/scheduleTimeZones.ts";
import { openFreshMigratedDatabase } from "../../test/support/freshDatabase.ts";

type TestDatabase = Awaited<ReturnType<typeof openFreshMigratedDatabase>>;

type CancellationPolicy = "cooperative" | "never" | "queued-only";
type ScheduleKind = "cron" | "daily" | "interval";
type TriggerType = "manual" | "schedule" | "startup" | "system";

interface ScheduleFixture {
    actionKey: string;
    actionPayloadJson: string;
    attemptLimit: number;
    cancellationPolicy: CancellationPolicy;
    createdAt: number;
    cronExpression: string | null;
    description: string;
    enabled: number;
    id: string;
    intervalMs: number | null;
    name: string;
    nextRunAt: number | null;
    priority: number;
    resourceClass: string;
    resourceKeysJson: string;
    retrySafe: number;
    scheduleKind: ScheduleKind;
    timeOfDay: string | null;
    timeZone: string | null;
    timeoutMs: number;
    updatedAt: number;
    version: number;
}

interface QueuedRunFixture {
    attemptLimit: number;
    cancellationPolicy: CancellationPolicy;
    id: string;
    idempotencyKey: string;
    requestedById: string;
    requestedByKind: "automation" | "system" | "user";
    resourceKeysJson: string;
    retrySafe: number;
    scheduledForAt: number | null;
    scheduledJobId: string | null;
    scheduledJobVersion: number | null;
    triggerType: TriggerType;
}

interface EventFixture {
    attempt: number;
    jobRunId: string;
    kind: string;
    message: string | null;
    occurredAt: number;
    progressJson: string | null;
    sequence: number;
    workerInstanceId: string | null;
}

interface QueryPlanRow {
    detail: string;
}

const userId = "019fdf00-0000-7000-8000-000000000001";
const releaseId = "a".repeat(40);
const enqueueSha256 = "b".repeat(64);

function uuid(index: number): string {
    return `019fdf00-0000-7000-8000-${String(index).padStart(12, "0")}`;
}

function idempotencyKey(index: number): string {
    return index.toString(16).padStart(32, "0");
}

function insertSchedule(
    database: TestDatabase,
    overrides: Partial<ScheduleFixture> = {}
): void {
    const fixture: ScheduleFixture = {
        actionKey: "system.worker-smoke",
        actionPayloadJson: "{}",
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        createdAt: 1000,
        cronExpression: null,
        description: "Safe worker smoke check",
        enabled: 1,
        id: "system.worker-smoke",
        intervalMs: 60_000,
        name: "Worker smoke",
        nextRunAt: 61_000,
        priority: 0,
        resourceClass: "light",
        resourceKeysJson: '["host.smoke"]',
        retrySafe: 1,
        scheduleKind: "interval",
        timeOfDay: null,
        timeZone: null,
        timeoutMs: 10_000,
        updatedAt: 1000,
        version: 1,
        ...overrides,
    };

    database.sqlite.run(
        `INSERT INTO scheduled_jobs (
            action_key, action_payload_json, attempt_limit, cancellation_policy,
            created_at, cron_expression, description, enabled, id, interval_ms,
            name, next_run_at, priority, resource_class, resource_keys_json,
            retry_safe, schedule_kind, time_of_day, time_zone, timeout_ms,
            updated_at, version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            fixture.actionKey,
            fixture.actionPayloadJson,
            fixture.attemptLimit,
            fixture.cancellationPolicy,
            fixture.createdAt,
            fixture.cronExpression,
            fixture.description,
            fixture.enabled,
            fixture.id,
            fixture.intervalMs,
            fixture.name,
            fixture.nextRunAt,
            fixture.priority,
            fixture.resourceClass,
            fixture.resourceKeysJson,
            fixture.retrySafe,
            fixture.scheduleKind,
            fixture.timeOfDay,
            fixture.timeZone,
            fixture.timeoutMs,
            fixture.updatedAt,
            fixture.version,
        ]
    );
}

function insertScheduleDisableIntent(
    database: TestDatabase,
    id: string,
    createdAt: number
): void {
    database.sqlite.run(
        `INSERT INTO job_disable_intents (
            created_at, created_by_id, created_by_kind, ended_at, ended_by_id,
            ended_by_kind, ended_reason, expires_at, external_job_id,
            external_provider, id, reason, scheduled_job_id, target_kind
        ) VALUES (?, ?, 'user', NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?, ?,
                  'dashboard-schedule')`,
        [createdAt, userId, id, "Operator maintenance", "system.worker-smoke"]
    );
}

function insertQueuedRun(
    database: TestDatabase,
    overrides: Partial<QueuedRunFixture> & Pick<QueuedRunFixture, "id" | "idempotencyKey">
): void {
    const fixture: QueuedRunFixture = {
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        requestedById: "job-scheduler",
        requestedByKind: "system",
        resourceKeysJson: "[]",
        retrySafe: 1,
        scheduledForAt: null,
        scheduledJobId: null,
        scheduledJobVersion: null,
        triggerType: "system",
        ...overrides,
    };

    database.sqlite.run(
        `INSERT INTO job_runs (
            action_key, attempt_limit, available_at, cancellation_policy,
            display_name, enqueue_sha256, id, idempotency_key, payload_json,
            priority, queued_at, requested_by_id, requested_by_kind,
            resource_class, resource_keys_json, retry_safe, scheduled_for_at,
            scheduled_job_id, scheduled_job_version, state, timeout_ms,
            trigger_type, updated_at
        ) VALUES (
            'system.worker-smoke', ?, 1000, ?, 'Worker smoke', ?, ?, ?, '{}',
            0, 1000, ?, ?, 'light', ?, ?, ?, ?, ?, 'queued', 10000, ?, 1000
        )`,
        [
            fixture.attemptLimit,
            fixture.cancellationPolicy,
            enqueueSha256,
            fixture.id,
            fixture.idempotencyKey,
            fixture.requestedById,
            fixture.requestedByKind,
            fixture.resourceKeysJson,
            fixture.retrySafe,
            fixture.scheduledForAt,
            fixture.scheduledJobId,
            fixture.scheduledJobVersion,
            fixture.triggerType,
        ]
    );
}

function insertWorker(database: TestDatabase, id: string, pid = 1000): void {
    database.sqlite.run(
        `INSERT INTO worker_instances (
            capacity, heartbeat_at, id, pid, release_id, started_at, state
        ) VALUES (4, 1000, ?, ?, ?, 1000, 'online')`,
        [id, pid, releaseId]
    );
}

function claimRun(
    database: TestDatabase,
    runId: string,
    workerId: string,
    leaseToken: string,
    startedAt = 2000,
    leaseExpiresAt = 5000
): void {
    database.sqlite.run(
        `UPDATE job_runs
         SET attempt_count = attempt_count + 1,
             first_started_at = COALESCE(first_started_at, ?),
             heartbeat_at = ?,
             last_attempt_started_at = ?,
             lease_expires_at = ?,
             lease_owner_id = ?,
             lease_token = ?,
             state = 'running',
             state_version = state_version + 1,
             updated_at = ?
         WHERE id = ?`,
        [
            startedAt,
            startedAt,
            startedAt,
            leaseExpiresAt,
            workerId,
            leaseToken,
            startedAt,
            runId,
        ]
    );
}

function insertEvent(
    database: TestDatabase,
    overrides: Partial<EventFixture> &
        Pick<EventFixture, "jobRunId" | "kind" | "sequence">
): void {
    const fixture: EventFixture = {
        attempt: 0,
        message: null,
        occurredAt: 1000,
        progressJson: null,
        workerInstanceId: null,
        ...overrides,
    };
    database.sqlite.run(
        `INSERT INTO job_run_events (
            attempt, job_run_id, kind, message, occurred_at, progress_json,
            sequence, worker_instance_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [
            fixture.attempt,
            fixture.jobRunId,
            fixture.kind,
            fixture.message,
            fixture.occurredAt,
            fixture.progressJson,
            fixture.sequence,
            fixture.workerInstanceId,
        ]
    );
}

function expectUsesIndexWithoutTemporarySort(
    database: TestDatabase,
    query: string,
    indexName: string,
    parameters: SQLQueryBindings[] = [],
    requiredDetail?: string,
    allowIndexScan = false
): void {
    const statement = `EXPLAIN QUERY PLAN ${query}`;
    const plan = database.sqlite
        .query<QueryPlanRow, SQLQueryBindings[]>(statement)
        .all(...parameters);
    expect(plan.some(({ detail }) => detail.includes(indexName))).toBeTrue();
    expect(
        plan.some(({ detail }) =>
            allowIndexScan
                ? detail.startsWith("SCAN job_runs") && !detail.includes("USING")
                : detail.startsWith("SCAN job_runs")
        )
    ).toBeFalse();
    expect(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE"))).toBeFalse();
    if (requiredDetail !== undefined) {
        expect(plan.some(({ detail }) => detail.includes(requiredDetail))).toBeTrue();
    }
}

describe("jobs baseline schema", () => {
    test("creates strict hardened tables and seeds required worker control", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(
                database.sqlite
                    .query<{ name: string; strict: number; wr: number }, []>(
                        `
                        SELECT name, strict, wr
                        FROM pragma_table_list
                        WHERE name IN (
                            'job_disable_intents', 'job_run_events', 'job_runs',
                            'job_worker_control', 'resource_leases',
                            'scheduled_jobs', 'worker_instances'
                        )
                        ORDER BY name
                    `
                    )
                    .all()
            ).toEqual([
                { name: "job_disable_intents", strict: 1, wr: 1 },
                { name: "job_run_events", strict: 1, wr: 1 },
                { name: "job_runs", strict: 1, wr: 1 },
                { name: "job_worker_control", strict: 1, wr: 0 },
                { name: "resource_leases", strict: 1, wr: 1 },
                { name: "scheduled_jobs", strict: 1, wr: 1 },
                { name: "worker_instances", strict: 1, wr: 1 },
            ]);
            expect(
                database.sqlite
                    .query<
                        {
                            claiming_paused: number;
                            id: number;
                            updated_at: number;
                            updated_by_id: string | null;
                            updated_by_kind: string | null;
                            version: number;
                        },
                        []
                    >("SELECT * FROM job_worker_control")
                    .get()
            ).toEqual({
                claiming_paused: 0,
                id: 1,
                updated_at: 0,
                updated_by_id: null,
                updated_by_kind: null,
                version: 1,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("rejects malformed schedule, resource, provenance, and idempotency shapes", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expect(() =>
                insertSchedule(database, {
                    id: "invalid.daily",
                    intervalMs: null,
                    nextRunAt: 70_000,
                    scheduleKind: "daily",
                    timeOfDay: "aa:bb",
                    timeZone: "UTC",
                })
            ).toThrow("scheduled_jobs_schedule_shape_check");
            expect(() =>
                insertSchedule(database, {
                    id: "invalid.daily-nul-suffix",
                    intervalMs: null,
                    scheduleKind: "daily",
                    timeOfDay: "09:00\0hidden",
                    timeZone: "UTC",
                })
            ).toThrow("scheduled_jobs_schedule_shape_check");
            for (const [index, cronExpression] of [
                "foo foo foo foo foo",
                "0 9 * JAN MON-FRI",
                "0\t9 * * *",
                "0 9 * * *\0hidden",
            ].entries()) {
                expect(() =>
                    insertSchedule(database, {
                        cronExpression,
                        id: `invalid.cron.${index}`,
                        intervalMs: null,
                        scheduleKind: "cron",
                        timeZone: "UTC",
                    })
                ).toThrow("scheduled_jobs_schedule_shape_check");
            }
            for (const [index, cronExpression] of [
                "99 99 99 99 99",
                "*/0 * * * *",
                "60 * * * *",
                "* 24 * * *",
                "* * 0 * *",
                "* * 32 * *",
                "* * * 0 *",
                "* * * 13 *",
                "* * * * 8",
                "*/60 * * * *",
                "* */24 * * *",
                "* * */32 * *",
                "* * * */13 *",
                "* * * * */8",
                "1-0 * * * *",
                "1//2 * * * *",
                "1-2-3 * * * *",
                "1,,2 * * * *",
                "0 0 30 2 *",
                "0 0 31 4 *",
                "0 0 31/1 2 */2",
                "0 0 30 2 */01",
                "0 0 31 2 *,1",
                "0 0 31 2-2/2 *",
                "0 0 31 2/12 *",
            ].entries()) {
                expect(
                    v.safeParse(scheduleCronExpressionSchema, cronExpression).success
                ).toBeFalse();
                expect(() =>
                    insertSchedule(database, {
                        cronExpression,
                        id: `invalid.cron-semantic.${index}`,
                        intervalMs: null,
                        scheduleKind: "cron",
                        timeZone: "UTC",
                    })
                ).toThrow("scheduled_jobs cron expression must be semantically valid");
            }
            const canonicalCronExpressions = [
                "* * * * *",
                "0 9 * 1 1-5",
                "*/15 0-23/2 1,15 1-12/3 0-7",
                "00 09 01 01 07",
                "1/59 1/23 1/31 1/12 0/7",
                "*,5 *,6 *,7 *,8 *,7",
                "0-59/59 0-23/23 1-31/31 1-12/12 0-7/7",
                "0 0 29 2 *",
                "0 0 31 2 1",
                "0 0 */31 2 1",
                "0 0 28,31 2 *",
                "0 0 31 2/2 *",
            ] as const;
            const fieldSamples = [
                {
                    baseline: ["0", "0", "1", "1", "*"],
                    fieldIndex: 0,
                    tokens: [
                        "*",
                        "*/1",
                        "*/59",
                        "0",
                        "59",
                        "01",
                        "1/59",
                        "0-59",
                        "1-59/2",
                        "0,15,30,45",
                        "*,5",
                    ],
                },
                {
                    baseline: ["0", "0", "1", "1", "*"],
                    fieldIndex: 1,
                    tokens: [
                        "*",
                        "*/1",
                        "*/23",
                        "0",
                        "23",
                        "01",
                        "1/23",
                        "0-23",
                        "1-23/2",
                        "0,6,12,18",
                        "*,5",
                    ],
                },
                {
                    baseline: ["0", "0", "1", "*", "*"],
                    fieldIndex: 2,
                    tokens: [
                        "*",
                        "*/1",
                        "*/31",
                        "1",
                        "31",
                        "01",
                        "1/31",
                        "1-31",
                        "2-30/2",
                        "1,15,31",
                        "*,7",
                    ],
                },
                {
                    baseline: ["0", "0", "1", "1", "*"],
                    fieldIndex: 3,
                    tokens: [
                        "*",
                        "*/1",
                        "*/12",
                        "1",
                        "12",
                        "01",
                        "1/12",
                        "1-12",
                        "2-12/2",
                        "1,6,12",
                        "*,7",
                    ],
                },
                {
                    baseline: ["0", "0", "1", "1", "0"],
                    fieldIndex: 4,
                    tokens: [
                        "*",
                        "*/1",
                        "*/7",
                        "0",
                        "7",
                        "01",
                        "0/7",
                        "0-7",
                        "1-7/2",
                        "0,1,6,7",
                        "*,5",
                    ],
                },
            ] as const;
            const generatedContractValidExpressions = fieldSamples.flatMap(
                ({ baseline, fieldIndex, tokens }) =>
                    tokens.map((token) => {
                        const fields: string[] = [...baseline];
                        fields[fieldIndex] = token;
                        return fields.join(" ");
                    })
            );
            const contractValidExpressions = [
                ...new Set([
                    ...canonicalCronExpressions,
                    ...generatedContractValidExpressions,
                ]),
            ];
            for (const [index, cronExpression] of contractValidExpressions.entries()) {
                expect(v.parse(scheduleCronExpressionSchema, cronExpression)).toBe(
                    cronExpression
                );
                insertSchedule(database, {
                    cronExpression,
                    id: `valid.canonical-cron.${index}`,
                    intervalMs: null,
                    scheduleKind: "cron",
                    timeZone: "UTC",
                });
            }
            for (const cronExpression of ["*/0 * * * *", "0 0 30 2 *"]) {
                expect(() =>
                    database.sqlite.run(
                        `UPDATE scheduled_jobs
                         SET cron_expression = ?, updated_at = 2000, version = 2
                         WHERE id = 'valid.canonical-cron.0'`,
                        [cronExpression]
                    )
                ).toThrow("scheduled_jobs cron expression must be semantically valid");
            }
            expect(
                database.sqlite
                    .query<{ cron_expression: string; version: number }, []>(
                        `SELECT cron_expression, version
                         FROM scheduled_jobs
                         WHERE id = 'valid.canonical-cron.0'`
                    )
                    .get()
            ).toEqual({ cron_expression: "* * * * *", version: 1 });
            for (const [index, nextRunAt] of [-1, 8_640_000_000_000_001].entries()) {
                expect(() =>
                    insertSchedule(database, {
                        enabled: 0,
                        id: `invalid.dormant-cursor.${index}`,
                        nextRunAt,
                    })
                ).toThrow("scheduled_jobs_next_run_check");
            }
            insertSchedule(database, {
                enabled: 0,
                id: "valid.null-dormant-cursor",
                nextRunAt: null,
            });
            expect(() =>
                insertSchedule(database, {
                    id: "invalid.enabled-null-cursor",
                    nextRunAt: null,
                })
            ).toThrow("scheduled_jobs_next_run_check");
            for (const [index, timeZone] of canonicalScheduleTimeZones.entries()) {
                insertSchedule(database, {
                    id: `valid.time-zone.${index}`,
                    intervalMs: null,
                    scheduleKind: "daily",
                    timeOfDay: "09:00",
                    timeZone,
                });
            }
            for (const [index, timeZone] of [
                "US/Eastern",
                "GMT",
                "+01:00",
                "local",
            ].entries()) {
                expect(() =>
                    insertSchedule(database, {
                        id: `invalid.time-zone.${index}`,
                        intervalMs: null,
                        scheduleKind: "daily",
                        timeOfDay: "09:00",
                        timeZone,
                    })
                ).toThrow("scheduled_jobs_time_zone_check");
            }
            expect(() =>
                insertSchedule(database, {
                    id: "invalid.resources",
                    resourceKeysJson: '["host.smoke","host.smoke"]',
                })
            ).toThrow("scheduled_jobs resource keys must be canonical");

            insertSchedule(database);
            expect(() =>
                insertQueuedRun(database, {
                    id: uuid(10),
                    idempotencyKey: idempotencyKey(10),
                    scheduledJobId: "system.worker-smoke",
                    scheduledJobVersion: 1,
                    triggerType: "system",
                })
            ).toThrow("job_runs_schedule_check");
            expect(() =>
                insertQueuedRun(database, {
                    id: uuid(11),
                    idempotencyKey: "A".repeat(33),
                })
            ).toThrow("job_runs_idempotency_key_check");
            expect(() =>
                insertQueuedRun(database, {
                    id: uuid(12),
                    idempotencyKey: idempotencyKey(12),
                    resourceKeysJson: '["UPPER",7,"duplicate","duplicate"]',
                })
            ).toThrow("job_runs resource keys must be canonical");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("separates scheduler cursor movement from versioned schedule configuration", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            insertSchedule(database);
            database.sqlite.run(
                "UPDATE scheduled_jobs SET next_run_at = 121000 WHERE id = ?",
                ["system.worker-smoke"]
            );
            expect(
                database.sqlite
                    .query<
                        { next_run_at: number; updated_at: number; version: number },
                        [string]
                    >(
                        "SELECT next_run_at, updated_at, version FROM scheduled_jobs WHERE id = ?"
                    )
                    .get("system.worker-smoke")
            ).toEqual({ next_run_at: 121_000, updated_at: 1000, version: 1 });

            expect(() =>
                database.sqlite.run(
                    "UPDATE scheduled_jobs SET next_run_at = 181000, version = 2 WHERE id = ?",
                    ["system.worker-smoke"]
                )
            ).toThrow("scheduled_jobs version transition is invalid");
            expect(() =>
                database.sqlite.run(
                    "UPDATE scheduled_jobs SET name = 'Changed' WHERE id = ?",
                    ["system.worker-smoke"]
                )
            ).toThrow("scheduled_jobs version transition is invalid");

            database.sqlite.run(
                `UPDATE scheduled_jobs
                 SET name = 'Changed', updated_at = 2000, version = 2
                 WHERE id = ?`,
                ["system.worker-smoke"]
            );
            expect(
                database.sqlite
                    .query<
                        { name: string; updated_at: number; version: number },
                        [string]
                    >("SELECT name, updated_at, version FROM scheduled_jobs WHERE id = ?")
                    .get("system.worker-smoke")
            ).toEqual({ name: "Changed", updated_at: 2000, version: 2 });

            database.sqlite.run(
                `UPDATE scheduled_jobs
                 SET enabled = 0, updated_at = 3000, version = 3
                 WHERE id = ?`,
                ["system.worker-smoke"]
            );
            expect(
                database.sqlite
                    .query<
                        {
                            enabled: number;
                            next_run_at: number;
                            updated_at: number;
                            version: number;
                        },
                        [string]
                    >(
                        "SELECT enabled, next_run_at, updated_at, version FROM scheduled_jobs WHERE id = ?"
                    )
                    .get("system.worker-smoke")
            ).toEqual({
                enabled: 0,
                next_run_at: 121_000,
                updated_at: 3000,
                version: 3,
            });

            expect(() =>
                database.sqlite.run(
                    `UPDATE scheduled_jobs
                     SET updated_at = 4000, version = 4
                     WHERE id = ?`,
                    ["system.worker-smoke"]
                )
            ).toThrow("scheduled_jobs version transition is invalid");

            const originalIntentId = uuid(13);
            insertScheduleDisableIntent(database, originalIntentId, 3000);
            expect(() =>
                database.sqlite.run(
                    `UPDATE scheduled_jobs
                     SET updated_at = 4000, version = 4
                     WHERE id = ?`,
                    ["system.worker-smoke"]
                )
            ).toThrow("scheduled_jobs version transition is invalid");

            database.sqlite.run(
                `UPDATE job_disable_intents
                 SET ended_at = 4000, ended_by_id = ?, ended_by_kind = 'user',
                     ended_reason = 'replaced'
                 WHERE id = ?`,
                [userId, originalIntentId]
            );
            insertScheduleDisableIntent(database, uuid(14), 4000);
            database.sqlite.run(
                `UPDATE scheduled_jobs
                 SET updated_at = 4000, version = 4
                 WHERE id = ?`,
                ["system.worker-smoke"]
            );
            expect(
                database.sqlite
                    .query<
                        { next_run_at: number; updated_at: number; version: number },
                        [string]
                    >(
                        "SELECT next_run_at, updated_at, version FROM scheduled_jobs WHERE id = ?"
                    )
                    .get("system.worker-smoke")
            ).toEqual({ next_run_at: 121_000, updated_at: 4000, version: 4 });

            expect(() =>
                database.sqlite.run(
                    `UPDATE scheduled_jobs
                     SET updated_at = 5000, version = 5
                     WHERE id = ?`,
                    ["system.worker-smoke"]
                )
            ).toThrow("scheduled_jobs version transition is invalid");
            expect(() =>
                database.sqlite.run(
                    `UPDATE scheduled_jobs
                     SET next_run_at = 181000, version = 5
                     WHERE id = ?`,
                    ["system.worker-smoke"]
                )
            ).toThrow("scheduled_jobs version transition is invalid");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("closes an external disable intent when its target is deleted", async () => {
        const database = await openFreshMigratedDatabase();
        const intentId = uuid(15);

        try {
            database.sqlite.run(
                `INSERT INTO job_disable_intents (
                    created_at, created_by_id, created_by_kind, ended_at, ended_by_id,
                    ended_by_kind, ended_reason, expires_at, external_job_id,
                    external_provider, id, reason, scheduled_job_id, target_kind
                ) VALUES (1000, ?, 'user', NULL, NULL, NULL, NULL, NULL, 'cron-cleanup',
                          'openclaw', ?, 'Operator maintenance', NULL, 'openclaw-cron')`,
                [userId, intentId]
            );
            database.sqlite.run(
                `UPDATE job_disable_intents
                 SET ended_at = 2000, ended_by_id = ?, ended_by_kind = 'user',
                     ended_reason = 'target-deleted'
                 WHERE id = ?`,
                [userId, intentId]
            );

            expect(
                database.sqlite
                    .query<{ ended_at: number; ended_reason: string }, [string]>(
                        `SELECT ended_at, ended_reason
                         FROM job_disable_intents
                         WHERE id = ?`
                    )
                    .get(intentId)
            ).toEqual({ ended_at: 2000, ended_reason: "target-deleted" });
            expect(() =>
                database.sqlite.run(
                    "UPDATE job_disable_intents SET reason = 'Changed' WHERE id = ?",
                    [intentId]
                )
            ).toThrow("closed job_disable_intents are immutable");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces immutable run snapshots and legal retry and cancellation lifecycles", async () => {
        const database = await openFreshMigratedDatabase();
        const workerId = uuid(20);

        try {
            insertWorker(database, workerId);

            const cooperativeRunId = uuid(21);
            insertQueuedRun(database, {
                id: cooperativeRunId,
                idempotencyKey: idempotencyKey(21),
            });
            insertEvent(database, {
                jobRunId: cooperativeRunId,
                kind: "queued",
                sequence: 1,
            });
            expect(() =>
                database.sqlite.run(
                    "UPDATE job_runs SET action_key = 'system.changed' WHERE id = ?",
                    [cooperativeRunId]
                )
            ).toThrow("job_runs execution snapshot is immutable");

            claimRun(database, cooperativeRunId, workerId, uuid(22));
            insertEvent(database, {
                attempt: 1,
                jobRunId: cooperativeRunId,
                kind: "claimed",
                occurredAt: 2000,
                sequence: 2,
                workerInstanceId: workerId,
            });
            database.sqlite.run(
                `UPDATE job_runs
                 SET cancel_requested_at = 2500,
                     cancel_requested_by_id = ?,
                     cancel_requested_by_kind = 'user',
                     state_version = state_version + 1,
                     updated_at = 2500
                 WHERE id = ?`,
                [userId, cooperativeRunId]
            );
            insertEvent(database, {
                attempt: 1,
                jobRunId: cooperativeRunId,
                kind: "cancel-requested",
                occurredAt: 2500,
                sequence: 3,
            });
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET available_at = 3000,
                         heartbeat_at = NULL,
                         lease_expires_at = NULL,
                         lease_owner_id = NULL,
                         lease_token = NULL,
                         state = 'queued',
                         state_version = state_version + 1,
                         updated_at = 2600
                     WHERE id = ?`,
                    [cooperativeRunId]
                )
            ).toThrow("job_runs lifecycle transition is invalid");
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 3000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'cancelled',
                     state_version = state_version + 1,
                     terminal_code = 'job/cancelled',
                     terminal_message = 'Cancelled cooperatively',
                     updated_at = 3000
                 WHERE id = ?`,
                [cooperativeRunId]
            );
            insertEvent(database, {
                attempt: 1,
                jobRunId: cooperativeRunId,
                kind: "cancelled",
                occurredAt: 3000,
                sequence: 4,
            });
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET available_at = 4000, finished_at = NULL, state = 'queued',
                         state_version = state_version + 1, terminal_code = NULL,
                         terminal_message = NULL, updated_at = 4000
                     WHERE id = ?`,
                    [cooperativeRunId]
                )
            ).toThrow("job_runs lifecycle transition is invalid");

            const retryRunId = uuid(23);
            insertQueuedRun(database, {
                id: retryRunId,
                idempotencyKey: idempotencyKey(23),
            });
            insertEvent(database, { jobRunId: retryRunId, kind: "queued", sequence: 1 });
            claimRun(database, retryRunId, workerId, uuid(24));
            insertEvent(database, {
                attempt: 1,
                jobRunId: retryRunId,
                kind: "claimed",
                occurredAt: 2000,
                sequence: 2,
                workerInstanceId: workerId,
            });
            database.sqlite.run(
                `UPDATE job_runs
                 SET available_at = 3000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'queued',
                     state_version = state_version + 1,
                     updated_at = 2500
                 WHERE id = ?`,
                [retryRunId]
            );
            insertEvent(database, {
                attempt: 1,
                jobRunId: retryRunId,
                kind: "retry-scheduled",
                occurredAt: 2500,
                sequence: 3,
            });
            claimRun(database, retryRunId, workerId, uuid(25), 3500, 6000);
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 4000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'failed',
                     state_version = state_version + 1,
                     terminal_code = 'failed/worker-lease-expired',
                     terminal_message = 'Worker lease expired',
                     updated_at = 4000
                 WHERE id = ?`,
                [retryRunId]
            );
            expect(
                database.sqlite
                    .query<
                        { attempt_count: number; state: string; terminal_code: string },
                        [string]
                    >(
                        "SELECT attempt_count, state, terminal_code FROM job_runs WHERE id = ?"
                    )
                    .get(retryRunId)
            ).toEqual({
                attempt_count: 2,
                state: "failed",
                terminal_code: "failed/worker-lease-expired",
            });

            const neverRunId = uuid(26);
            insertQueuedRun(database, {
                cancellationPolicy: "never",
                id: neverRunId,
                idempotencyKey: idempotencyKey(26),
            });
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET finished_at = 1500, state = 'cancelled', state_version = 2,
                         terminal_code = 'job/cancelled', terminal_message = 'Cancelled',
                         updated_at = 1500
                     WHERE id = ?`,
                    [neverRunId]
                )
            ).toThrow("job_runs lifecycle transition is invalid");

            const queuedOnlyRunId = uuid(27);
            insertQueuedRun(database, {
                cancellationPolicy: "queued-only",
                id: queuedOnlyRunId,
                idempotencyKey: idempotencyKey(27),
            });
            claimRun(database, queuedOnlyRunId, workerId, uuid(28));
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET cancel_requested_at = 2500,
                         cancel_requested_by_id = ?,
                         cancel_requested_by_kind = 'user',
                         state_version = state_version + 1,
                         updated_at = 2500
                     WHERE id = ?`,
                    [userId, queuedOnlyRunId]
                )
            ).toThrow("job_runs lifecycle transition is invalid");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces durable event attempts for every lifecycle kind", async () => {
        const database = await openFreshMigratedDatabase();
        const workerId = uuid(70);

        const prepareStartedRun = (runIndex: number, leaseIndex: number): string => {
            const runId = uuid(runIndex);
            insertQueuedRun(database, {
                id: runId,
                idempotencyKey: idempotencyKey(runIndex),
            });
            insertEvent(database, { jobRunId: runId, kind: "queued", sequence: 1 });
            claimRun(database, runId, workerId, uuid(leaseIndex));
            return runId;
        };
        const expectStartedEventAttempts = (
            runId: string,
            sequence: number,
            event: Partial<EventFixture> & Pick<EventFixture, "kind">,
            occurredAt = 2000
        ): void => {
            expect(() =>
                insertEvent(database, {
                    ...event,
                    attempt: 0,
                    jobRunId: runId,
                    occurredAt,
                    sequence,
                    workerInstanceId: workerId,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            insertEvent(database, {
                ...event,
                attempt: 1,
                jobRunId: runId,
                occurredAt,
                sequence,
                workerInstanceId: workerId,
            });
        };

        try {
            insertWorker(database, workerId);

            const runningRunId = prepareStartedRun(71, 81);
            const runningEvents = [
                { kind: "claimed" },
                { kind: "failed", message: "Attempt failed" },
                { kind: "lease-expired" },
                { kind: "output-truncated" },
                { kind: "progress", progressJson: "{}" },
                { kind: "stderr", message: "stderr" },
                { kind: "stdout", message: "stdout" },
            ];
            let sequence = 2;
            for (const event of runningEvents) {
                expectStartedEventAttempts(runningRunId, sequence, event);
                sequence += 1;
            }
            expect(() =>
                insertEvent(database, {
                    attempt: 2,
                    jobRunId: runningRunId,
                    kind: "lease-expired",
                    occurredAt: 2000,
                    sequence,
                    workerInstanceId: workerId,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_run_events SET attempt = 0
                     WHERE job_run_id = ? AND sequence = 2`,
                    [runningRunId]
                )
            ).toThrow("job_run_events are append-only");
            expect(() =>
                database.sqlite.run(
                    `INSERT OR REPLACE INTO job_run_events (
                        attempt, job_run_id, kind, message, occurred_at,
                        progress_json, sequence, worker_instance_id
                    ) VALUES (1, ?, 'claimed', NULL, 2000, NULL, 2, ?)`,
                    [runningRunId, workerId]
                )
            ).toThrow();
            expect(() =>
                database.sqlite.run(
                    `INSERT OR REPLACE INTO job_run_events (
                        attempt, job_run_id, kind, message, occurred_at,
                        progress_json, sequence, worker_instance_id
                    ) VALUES (0, ?, 'stdout', 'stdout', 2000, NULL, ?, ?)`,
                    [runningRunId, sequence, workerId]
                )
            ).toThrow("job_run_events must follow the parent run lifecycle");

            const retryRunId = prepareStartedRun(72, 82);
            database.sqlite.run(
                `UPDATE job_runs
                 SET available_at = 3000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'queued',
                     state_version = state_version + 1,
                     updated_at = 2500
                 WHERE id = ?`,
                [retryRunId]
            );
            expectStartedEventAttempts(retryRunId, 2, { kind: "retry-scheduled" }, 2500);

            const succeededRunId = prepareStartedRun(73, 83);
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 2500,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     result_json = '{}',
                     state = 'succeeded',
                     state_version = state_version + 1,
                     updated_at = 2500
                 WHERE id = ?`,
                [succeededRunId]
            );
            expectStartedEventAttempts(succeededRunId, 2, { kind: "succeeded" }, 2500);

            const timedOutRunId = prepareStartedRun(74, 84);
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 2500,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'timed-out',
                     state_version = state_version + 1,
                     terminal_code = 'action-timeout',
                     terminal_message = 'Action timed out',
                     updated_at = 2500
                 WHERE id = ?`,
                [timedOutRunId]
            );
            expectStartedEventAttempts(timedOutRunId, 2, { kind: "timed-out" }, 2500);

            const cancelledRunId = uuid(75);
            insertQueuedRun(database, {
                id: cancelledRunId,
                idempotencyKey: idempotencyKey(75),
            });
            insertEvent(database, {
                jobRunId: cancelledRunId,
                kind: "queued",
                sequence: 1,
            });
            database.sqlite.run(
                `UPDATE job_runs
                 SET cancel_requested_at = 1500,
                     cancel_requested_by_id = ?,
                     cancel_requested_by_kind = 'user',
                     finished_at = 1500,
                     state = 'cancelled',
                     state_version = state_version + 1,
                     terminal_code = 'job/cancelled',
                     terminal_message = 'Cancelled before start',
                     updated_at = 1500
                 WHERE id = ?`,
                [userId, cancelledRunId]
            );
            insertEvent(database, {
                attempt: 0,
                jobRunId: cancelledRunId,
                kind: "cancel-requested",
                occurredAt: 1500,
                sequence: 2,
            });
            insertEvent(database, {
                attempt: 0,
                jobRunId: cancelledRunId,
                kind: "cancelled",
                occurredAt: 1500,
                sequence: 3,
            });
            for (const kind of ["cancel-requested", "cancelled"]) {
                expect(() =>
                    insertEvent(database, {
                        attempt: 1,
                        jobRunId: cancelledRunId,
                        kind,
                        occurredAt: 1500,
                        sequence: 4,
                    })
                ).toThrow("job_run_events must follow the parent run lifecycle");
            }

            const queuedRunId = uuid(76);
            insertQueuedRun(database, {
                id: queuedRunId,
                idempotencyKey: idempotencyKey(76),
            });
            expect(() =>
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: queuedRunId,
                    kind: "queued",
                    sequence: 1,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            expect(() =>
                insertEvent(database, {
                    attempt: 0,
                    jobRunId: queuedRunId,
                    kind: "queued",
                    sequence: 1,
                    workerInstanceId: workerId,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            expect(() =>
                database.sqlite.run(
                    `INSERT OR REPLACE INTO job_run_events (
                        attempt, job_run_id, kind, message, occurred_at,
                        progress_json, sequence, worker_instance_id
                    ) VALUES (0, ?, 'queued', NULL, 1000, NULL, 1, ?)`,
                    [queuedRunId, workerId]
                )
            ).toThrow("job_run_events must follow the parent run lifecycle");
            insertEvent(database, {
                attempt: 0,
                jobRunId: queuedRunId,
                kind: "queued",
                sequence: 1,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("serializes append-only events and enforces count, payload, and byte budgets", async () => {
        const database = await openFreshMigratedDatabase();
        const workerId = uuid(30);

        try {
            insertWorker(database, workerId);

            const payloadRunId = uuid(31);
            insertQueuedRun(database, {
                id: payloadRunId,
                idempotencyKey: idempotencyKey(31),
            });
            insertEvent(database, {
                jobRunId: payloadRunId,
                kind: "queued",
                sequence: 1,
            });
            claimRun(database, payloadRunId, workerId, uuid(32));
            insertEvent(database, {
                attempt: 1,
                jobRunId: payloadRunId,
                kind: "claimed",
                occurredAt: 2000,
                sequence: 2,
                workerInstanceId: workerId,
            });
            for (let index = 0; index < 967; index += 1) {
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: payloadRunId,
                    kind: "stdout",
                    message: "x",
                    occurredAt: 2000,
                    sequence: index + 3,
                    workerInstanceId: workerId,
                });
            }
            expect(() =>
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: payloadRunId,
                    kind: "stdout",
                    message: "x",
                    occurredAt: 2000,
                    sequence: 970,
                    workerInstanceId: workerId,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            expect(
                database.sqlite
                    .query<
                        {
                            event_bytes: number;
                            event_count: number;
                            payload_event_count: number;
                        },
                        [string]
                    >(
                        `SELECT event_bytes, event_count, payload_event_count
                             FROM job_runs WHERE id = ?`
                    )
                    .get(payloadRunId)
            ).toEqual({ event_bytes: 967, event_count: 969, payload_event_count: 967 });

            expect(() =>
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: payloadRunId,
                    kind: "lease-expired",
                    occurredAt: 2000,
                    sequence: 971,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_run_events SET occurred_at = 2001
                         WHERE job_run_id = ? AND sequence = 1`,
                    [payloadRunId]
                )
            ).toThrow("job_run_events are append-only");
            expect(() =>
                database.sqlite.run(
                    "DELETE FROM job_run_events WHERE job_run_id = ? AND sequence = 1",
                    [payloadRunId]
                )
            ).toThrow("job_run_events are append-only");

            const totalRunId = uuid(33);
            insertQueuedRun(database, {
                id: totalRunId,
                idempotencyKey: idempotencyKey(33),
            });
            insertEvent(database, { jobRunId: totalRunId, kind: "queued", sequence: 1 });
            claimRun(database, totalRunId, workerId, uuid(34));
            insertEvent(database, {
                attempt: 1,
                jobRunId: totalRunId,
                kind: "claimed",
                occurredAt: 2000,
                sequence: 2,
            });
            for (let sequence = 3; sequence <= 1000; sequence += 1) {
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: totalRunId,
                    kind: "lease-expired",
                    occurredAt: 2000,
                    sequence,
                });
            }
            expect(
                database.sqlite
                    .query<{ event_count: number }, [string]>(
                        "SELECT event_count FROM job_runs WHERE id = ?"
                    )
                    .get(totalRunId)
            ).toEqual({ event_count: 1000 });
            expect(() =>
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: totalRunId,
                    kind: "lease-expired",
                    occurredAt: 2000,
                    sequence: 1001,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");

            const bytesRunId = uuid(35);
            insertQueuedRun(database, {
                id: bytesRunId,
                idempotencyKey: idempotencyKey(35),
            });
            insertEvent(database, { jobRunId: bytesRunId, kind: "queued", sequence: 1 });
            claimRun(database, bytesRunId, workerId, uuid(36));
            insertEvent(database, {
                attempt: 1,
                jobRunId: bytesRunId,
                kind: "claimed",
                occurredAt: 2000,
                sequence: 2,
            });
            const chunk = "x".repeat(4096);
            for (let index = 0; index < 246; index += 1) {
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: bytesRunId,
                    kind: "stdout",
                    message: chunk,
                    occurredAt: 2000,
                    sequence: index + 3,
                });
            }
            expect(
                database.sqlite
                    .query<{ event_bytes: number }, [string]>(
                        "SELECT event_bytes FROM job_runs WHERE id = ?"
                    )
                    .get(bytesRunId)
            ).toEqual({ event_bytes: 1_007_616 });
            expect(() =>
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: bytesRunId,
                    kind: "stdout",
                    message: "x",
                    occurredAt: 2000,
                    sequence: 249,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
            for (let index = 0; index < 9; index += 1) {
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: bytesRunId,
                    kind: "failed",
                    message: chunk,
                    occurredAt: 2000,
                    sequence: index + 249,
                    workerInstanceId: workerId,
                });
            }
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 2000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'failed',
                     state_version = state_version + 1,
                     terminal_code = 'job/failed',
                     terminal_message = 'Terminal failure',
                     updated_at = 2000
                 WHERE id = ?`,
                [bytesRunId]
            );
            insertEvent(database, {
                attempt: 1,
                jobRunId: bytesRunId,
                kind: "failed",
                message: chunk,
                occurredAt: 2000,
                sequence: 258,
                workerInstanceId: workerId,
            });
            expect(
                database.sqlite
                    .query<{ event_bytes: number }, [string]>(
                        "SELECT event_bytes FROM job_runs WHERE id = ?"
                    )
                    .get(bytesRunId)
            ).toEqual({ event_bytes: 1024 * 1024 });

            const runningFailureRunId = uuid(60);
            insertQueuedRun(database, {
                id: runningFailureRunId,
                idempotencyKey: idempotencyKey(60),
            });
            insertEvent(database, {
                jobRunId: runningFailureRunId,
                kind: "queued",
                sequence: 1,
            });
            claimRun(database, runningFailureRunId, workerId, uuid(61));
            insertEvent(database, {
                attempt: 1,
                jobRunId: runningFailureRunId,
                kind: "failed",
                message: "Retryable attempt failed",
                occurredAt: 2000,
                sequence: 2,
                workerInstanceId: workerId,
            });
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 2000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'failed',
                     state_version = state_version + 1,
                     terminal_code = 'job/failed',
                     terminal_message = 'Terminal failure',
                     updated_at = 2000
                 WHERE id = ?`,
                [runningFailureRunId]
            );
            insertEvent(database, {
                attempt: 1,
                jobRunId: runningFailureRunId,
                kind: "failed",
                message: "Terminal failure",
                occurredAt: 2000,
                sequence: 3,
                workerInstanceId: workerId,
            });

            const queuedFailureRunId = uuid(62);
            insertQueuedRun(database, {
                id: queuedFailureRunId,
                idempotencyKey: idempotencyKey(62),
            });
            insertEvent(database, {
                jobRunId: queuedFailureRunId,
                kind: "queued",
                sequence: 1,
            });
            expect(() =>
                insertEvent(database, {
                    jobRunId: queuedFailureRunId,
                    kind: "failed",
                    message: "Invalid queued failure",
                    occurredAt: 1000,
                    sequence: 2,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");

            const succeededFailureRunId = uuid(63);
            insertQueuedRun(database, {
                id: succeededFailureRunId,
                idempotencyKey: idempotencyKey(63),
            });
            insertEvent(database, {
                jobRunId: succeededFailureRunId,
                kind: "queued",
                sequence: 1,
            });
            claimRun(database, succeededFailureRunId, workerId, uuid(64));
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 2000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     result_json = '{}',
                     state = 'succeeded',
                     state_version = state_version + 1,
                     updated_at = 2000
                 WHERE id = ?`,
                [succeededFailureRunId]
            );
            expect(() =>
                insertEvent(database, {
                    attempt: 1,
                    jobRunId: succeededFailureRunId,
                    kind: "failed",
                    message: "Invalid post-success failure",
                    occurredAt: 2000,
                    sequence: 2,
                    workerInstanceId: workerId,
                })
            ).toThrow("job_run_events must follow the parent run lifecycle");
        } finally {
            database.sqlite.close(true);
        }
    }, 30_000);

    test("enforces singleton CAS and replacement and deletion resistance", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            database.sqlite.run(
                `UPDATE job_worker_control
                 SET claiming_paused = 1, updated_at = 1000,
                     updated_by_id = ?, updated_by_kind = 'user', version = 2
                 WHERE id = 1`,
                [userId]
            );
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_worker_control
                     SET claiming_paused = 0, updated_at = 2000,
                         updated_by_id = ?, updated_by_kind = 'user', version = 2
                     WHERE id = 1`,
                    [userId]
                )
            ).toThrow("job_worker_control transition is invalid");
            expect(() =>
                database.sqlite.run(
                    `INSERT OR REPLACE INTO job_worker_control (
                        claiming_paused, id, updated_at, updated_by_id,
                        updated_by_kind, version
                    ) VALUES (0, 1, 2000, ?, 'user', 3)`,
                    [userId]
                )
            ).toThrow("job_worker_control singleton already exists");
            expect(() => database.sqlite.run("DELETE FROM job_worker_control")).toThrow(
                "job_worker_control singleton cannot be deleted"
            );
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces worker lifecycle and resource-lease fencing", async () => {
        const database = await openFreshMigratedDatabase();
        const workerId = uuid(40);
        const otherWorkerId = uuid(41);
        const lifecycleWorkerId = uuid(42);
        const runId = uuid(43);
        const leaseToken = uuid(44);

        try {
            insertWorker(database, workerId, 1001);
            insertWorker(database, otherWorkerId, 1002);
            insertWorker(database, lifecycleWorkerId, 1003);
            insertQueuedRun(database, {
                id: runId,
                idempotencyKey: idempotencyKey(43),
                resourceKeysJson: '["host.smoke"]',
            });
            claimRun(database, runId, workerId, leaseToken);

            expect(() =>
                database.sqlite.run(
                    `INSERT INTO resource_leases (
                        acquired_at, expires_at, job_run_id, lease_token,
                        renewed_at, resource_key, worker_instance_id
                    ) VALUES (2000, 5000, ?, ?, 2000, 'host.other', ?)`,
                    [runId, leaseToken, workerId]
                )
            ).toThrow("resource_leases must match one active fenced claim");
            expect(() =>
                database.sqlite.run(
                    `INSERT INTO resource_leases (
                        acquired_at, expires_at, job_run_id, lease_token,
                        renewed_at, resource_key, worker_instance_id
                    ) VALUES (2000, 5000, ?, ?, 2000, 'host.smoke', ?)`,
                    [runId, uuid(45), otherWorkerId]
                )
            ).toThrow("resource_leases must match one active fenced claim");
            database.sqlite.run(
                `INSERT INTO resource_leases (
                    acquired_at, expires_at, job_run_id, lease_token,
                    renewed_at, resource_key, worker_instance_id
                ) VALUES (2000, 5000, ?, ?, 2000, 'host.smoke', ?)`,
                [runId, leaseToken, workerId]
            );

            database.sqlite.run(
                `UPDATE job_runs
                 SET heartbeat_at = 2500, lease_expires_at = 6000, updated_at = 2500
                 WHERE id = ?`,
                [runId]
            );
            database.sqlite.run(
                `UPDATE resource_leases
                 SET expires_at = 6000, renewed_at = 2500
                 WHERE resource_key = 'host.smoke'`
            );
            expect(() =>
                database.sqlite.run(
                    `UPDATE resource_leases
                     SET expires_at = 7000, renewed_at = 3000
                     WHERE resource_key = 'host.smoke'`
                )
            ).toThrow("resource_leases renewal is not fenced");
            expect(() =>
                database.sqlite.run(
                    `UPDATE resource_leases SET resource_key = 'host.changed'
                     WHERE resource_key = 'host.smoke'`
                )
            ).toThrow("resource_leases renewal is not fenced");

            database.sqlite.run(
                "UPDATE worker_instances SET heartbeat_at = 1500 WHERE id = ?",
                [lifecycleWorkerId]
            );
            expect(() =>
                database.sqlite.run(
                    "UPDATE worker_instances SET heartbeat_at = 1400 WHERE id = ?",
                    [lifecycleWorkerId]
                )
            ).toThrow("worker_instances lifecycle transition is invalid");
            expect(() =>
                database.sqlite.run(
                    `UPDATE worker_instances
                     SET draining_at = 1600, heartbeat_at = 1700, state = 'stopped',
                         stopped_at = 1700
                     WHERE id = ?`,
                    [lifecycleWorkerId]
                )
            ).toThrow("worker_instances lifecycle transition is invalid");
            database.sqlite.run(
                `UPDATE worker_instances
                 SET draining_at = 1600, heartbeat_at = 1600, state = 'draining'
                 WHERE id = ?`,
                [lifecycleWorkerId]
            );
            database.sqlite.run(
                `UPDATE worker_instances
                 SET heartbeat_at = 1700, state = 'stopped', stopped_at = 1700
                 WHERE id = ?`,
                [lifecycleWorkerId]
            );
            expect(() =>
                database.sqlite.run(
                    "UPDATE worker_instances SET heartbeat_at = 1800 WHERE id = ?",
                    [lifecycleWorkerId]
                )
            ).toThrow("worker_instances lifecycle transition is invalid");
        } finally {
            database.sqlite.close(true);
        }
    });

    test("enforces stored run time ordering across raw insert and update boundaries", async () => {
        const database = await openFreshMigratedDatabase();
        const workerId = uuid(90);
        const runningRunId = uuid(93);

        const transitionToRunning = (
            firstStartedAt: number,
            lastAttemptStartedAt: number,
            heartbeatAt: number,
            leaseExpiresAt: number,
            updatedAt: number
        ): void => {
            database.sqlite.run(
                `UPDATE job_runs
                 SET attempt_count = 1,
                     first_started_at = ?,
                     heartbeat_at = ?,
                     last_attempt_started_at = ?,
                     lease_expires_at = ?,
                     lease_owner_id = ?,
                     lease_token = ?,
                     state = 'running',
                     state_version = 2,
                     updated_at = ?
                 WHERE id = ?`,
                [
                    firstStartedAt,
                    heartbeatAt,
                    lastAttemptStartedAt,
                    leaseExpiresAt,
                    workerId,
                    uuid(94),
                    updatedAt,
                    runningRunId,
                ]
            );
        };

        try {
            insertSchedule(database);
            insertWorker(database, workerId);

            expect(() =>
                insertQueuedRun(database, {
                    id: uuid(91),
                    idempotencyKey: idempotencyKey(91),
                    scheduledForAt: 1001,
                    scheduledJobId: "system.worker-smoke",
                    scheduledJobVersion: 1,
                    triggerType: "schedule",
                })
            ).toThrow("job_runs_schedule_check");
            const scheduledRunId = uuid(92);
            insertQueuedRun(database, {
                id: scheduledRunId,
                idempotencyKey: idempotencyKey(92),
                scheduledForAt: 1000,
                scheduledJobId: "system.worker-smoke",
                scheduledJobVersion: 1,
                triggerType: "schedule",
            });
            expect(() =>
                database.sqlite.run(
                    `INSERT OR REPLACE INTO job_runs
                     SELECT * FROM job_runs WHERE id = ?`,
                    [scheduledRunId]
                )
            ).toThrow("job_runs identity is immutable");
            expect(() =>
                database.sqlite.run(
                    "UPDATE OR REPLACE job_runs SET scheduled_for_at = 1001 WHERE id = ?",
                    [scheduledRunId]
                )
            ).toThrow("job_runs execution snapshot is immutable");

            insertQueuedRun(database, {
                id: runningRunId,
                idempotencyKey: idempotencyKey(93),
            });
            expect(() =>
                database.sqlite.run(
                    "UPDATE job_runs SET available_at = 999 WHERE id = ?",
                    [runningRunId]
                )
            ).toThrow("job_runs_available_at_check");
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET cancel_requested_at = 999,
                         cancel_requested_by_id = ?,
                         cancel_requested_by_kind = 'user',
                         state_version = 2
                     WHERE id = ?`,
                    [userId, runningRunId]
                )
            ).toThrow("job_runs_cancel_request_check");
            expect(() =>
                database.sqlite.run(
                    `UPDATE OR REPLACE job_runs
                     SET cancel_requested_at = 1500,
                         cancel_requested_by_id = ?,
                         cancel_requested_by_kind = 'user',
                         state_version = 2,
                         updated_at = 1200
                     WHERE id = ?`,
                    [userId, runningRunId]
                )
            ).toThrow("job_runs_cancel_request_check");
            expect(() =>
                database.sqlite.run(
                    `UPDATE OR REPLACE job_runs
                     SET finished_at = 1000,
                         state = 'cancelled',
                         state_version = 2,
                         terminal_code = 'job/cancelled',
                         terminal_message = 'Missing durable request'
                     WHERE id = ?`,
                    [runningRunId]
                )
            ).toThrow("job_runs_cancel_request_check");

            expect(() => transitionToRunning(999, 999, 999, 5000, 1000)).toThrow(
                "job_runs_time_check"
            );
            expect(() => transitionToRunning(1200, 1200, 1200, 5000, 1100)).toThrow(
                "job_runs_time_check"
            );
            expect(() => transitionToRunning(1100, 1050, 1100, 5000, 1100)).toThrow(
                "job_runs_time_check"
            );
            expect(() => transitionToRunning(1100, 1100, 1050, 5000, 1100)).toThrow(
                "job_runs_lease_check"
            );
            expect(() => transitionToRunning(1100, 1100, 1200, 5000, 1150)).toThrow(
                "job_runs_time_check"
            );
            expect(() => transitionToRunning(1100, 1100, 1100, 1100, 1100)).toThrow(
                "job_runs_lease_check"
            );

            transitionToRunning(1100, 1100, 1100, 5000, 1100);
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET cancel_requested_at = 1300,
                         cancel_requested_by_id = ?,
                         cancel_requested_by_kind = 'user',
                         state_version = 3,
                         updated_at = 1200
                     WHERE id = ?`,
                    [userId, runningRunId]
                )
            ).toThrow("job_runs_cancel_request_check");
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET finished_at = 1050,
                         heartbeat_at = NULL,
                         lease_expires_at = NULL,
                         lease_owner_id = NULL,
                         lease_token = NULL,
                         state = 'failed',
                         state_version = 3,
                         terminal_code = 'job/failed',
                         terminal_message = 'Backdated terminal time',
                         updated_at = 1200
                     WHERE id = ?`,
                    [runningRunId]
                )
            ).toThrow("job_runs_time_check");
            expect(() =>
                database.sqlite.run(
                    `UPDATE job_runs
                     SET finished_at = 1300,
                         heartbeat_at = NULL,
                         lease_expires_at = NULL,
                         lease_owner_id = NULL,
                         lease_token = NULL,
                         state = 'failed',
                         state_version = 3,
                         terminal_code = 'job/failed',
                         terminal_message = 'Future terminal time',
                         updated_at = 1200
                     WHERE id = ?`,
                    [runningRunId]
                )
            ).toThrow("job_runs_time_check");

            database.sqlite.run(
                `UPDATE job_runs
                 SET available_at = 5000,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'queued',
                     state_version = 3
                 WHERE id = ?`,
                [runningRunId]
            );
            claimRun(database, runningRunId, workerId, uuid(95), 1100, 5000);
            database.sqlite.run(
                `UPDATE job_runs
                 SET finished_at = 1100,
                     heartbeat_at = NULL,
                     lease_expires_at = NULL,
                     lease_owner_id = NULL,
                     lease_token = NULL,
                     state = 'failed',
                     state_version = 5,
                     terminal_code = 'job/failed',
                     terminal_message = 'Clock-clamped terminal failure',
                     updated_at = 1100
                 WHERE id = ?`,
                [runningRunId]
            );
            expect(
                database.sqlite
                    .query<
                        {
                            attempt_count: number;
                            available_at: number;
                            finished_at: number;
                            first_started_at: number;
                            last_attempt_started_at: number;
                            state: string;
                            updated_at: number;
                        },
                        [string]
                    >(
                        `SELECT attempt_count, available_at, finished_at,
                                first_started_at, last_attempt_started_at, state,
                                updated_at
                         FROM job_runs WHERE id = ?`
                    )
                    .get(runningRunId)
            ).toEqual({
                attempt_count: 2,
                available_at: 5000,
                finished_at: 1100,
                first_started_at: 1100,
                last_attempt_started_at: 1100,
                state: "failed",
                updated_at: 1100,
            });

            const cancelledRunId = uuid(96);
            insertQueuedRun(database, {
                id: cancelledRunId,
                idempotencyKey: idempotencyKey(96),
            });
            database.sqlite.run(
                `UPDATE OR REPLACE job_runs
                 SET cancel_requested_at = 1000,
                     cancel_requested_by_id = ?,
                     cancel_requested_by_kind = 'user',
                     finished_at = 1000,
                     state = 'cancelled',
                     state_version = 2,
                     terminal_code = 'job/cancelled',
                     terminal_message = 'Clock-clamped queued cancellation'
                 WHERE id = ?`,
                [userId, cancelledRunId]
            );
            expect(
                database.sqlite
                    .query<
                        {
                            cancel_requested_at: number;
                            finished_at: number;
                            state: string;
                            updated_at: number;
                        },
                        [string]
                    >(
                        `SELECT cancel_requested_at, finished_at, state, updated_at
                         FROM job_runs WHERE id = ?`
                    )
                    .get(cancelledRunId)
            ).toEqual({
                cancel_requested_at: 1000,
                finished_at: 1000,
                state: "cancelled",
                updated_at: 1000,
            });
        } finally {
            database.sqlite.close(true);
        }
    });

    test("uses bounded indexes for claim, history, expiry, and scheduler reads", async () => {
        const database = await openFreshMigratedDatabase();

        try {
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE state = 'queued' AND available_at <= 1000
                 ORDER BY available_at ASC, priority DESC, queued_at ASC, id ASC
                 LIMIT 32`,
                "job_runs_claim_idx"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE state = 'queued' AND available_at <= 1000
                   AND available_at = 900 AND priority = 2
                   AND queued_at = 800 AND id > '019f0000-0000-7000-8000-000000000001'
                 ORDER BY available_at ASC, priority DESC, queued_at ASC, id ASC
                 LIMIT 32`,
                "job_runs_claim_idx",
                [],
                "id>?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE state = 'queued' AND available_at <= 1000
                   AND available_at = 900 AND priority = 2 AND queued_at > 800
                 ORDER BY available_at ASC, priority DESC, queued_at ASC, id ASC
                 LIMIT 32`,
                "job_runs_claim_idx",
                [],
                "queued_at>?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE state = 'queued' AND available_at <= 1000
                   AND available_at = 900 AND priority < 2
                 ORDER BY available_at ASC, priority DESC, queued_at ASC, id ASC
                 LIMIT 32`,
                "job_runs_claim_idx",
                [],
                "priority<?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE state = 'queued' AND available_at <= 1000
                   AND available_at > 900
                 ORDER BY available_at ASC, priority DESC, queued_at ASC, id ASC
                 LIMIT 32`,
                "job_runs_claim_idx",
                [],
                "available_at>? AND available_at<?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                "SELECT id FROM job_runs ORDER BY queued_at DESC, id DESC LIMIT 50",
                "job_runs_queued_id_idx",
                [],
                undefined,
                true
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE scheduled_job_id = 'system.worker-smoke'
                 ORDER BY queued_at DESC, id DESC LIMIT 50`,
                "job_runs_schedule_queued_id_idx"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE action_key = ? AND payload_json = ?
                   AND state IN ('queued', 'running')
                 ORDER BY state DESC, queued_at DESC, id DESC LIMIT 1`,
                "job_runs_action_active_idx",
                ["maintenance.rotate-logs", '{"policyId":"docker-managed"}'],
                "action_key=? AND state=?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE action_key = ? AND state IN ('queued', 'running') LIMIT 1`,
                "job_runs_action_active_idx",
                ["maintenance.rotate-logs"],
                "action_key=?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE action_key = 'maintenance.rotate-logs'
                   AND length(CAST(payload_json AS BLOB)) <= 128
                   AND payload_json = ?
                   AND state IN ('cancelled', 'failed', 'succeeded', 'timed-out')
                 ORDER BY queued_at DESC, id DESC LIMIT 1`,
                "job_runs_action_payload_terminal_idx",
                ['{"policyId":"docker-managed"}'],
                "action_key=? AND payload_json=?"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM job_runs
                 WHERE state = 'running' AND lease_owner_id = ?
                 ORDER BY id`,
                "job_runs_running_owner_id_idx",
                [uuid(50)]
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM scheduled_jobs
                 WHERE enabled = 1 AND next_run_at <= 1000
                 ORDER BY next_run_at ASC, id ASC LIMIT 32`,
                "scheduled_jobs_due_idx"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM scheduled_jobs
                 WHERE enabled = 1 AND next_run_at <= 1000
                   AND (next_run_at, id) >
                       (900, 'system.worker-smoke-001')
                 ORDER BY next_run_at ASC, id ASC LIMIT 32`,
                "scheduled_jobs_due_idx",
                [],
                "(next_run_at,id)>(?,?)"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT id FROM worker_instances
                 WHERE heartbeat_at < 1000 ORDER BY heartbeat_at ASC, id ASC`,
                "worker_instances_heartbeat_id_idx"
            );
            expectUsesIndexWithoutTemporarySort(
                database,
                `SELECT resource_key FROM resource_leases
                 WHERE expires_at <= 1000 ORDER BY expires_at ASC, resource_key ASC`,
                "resource_leases_expiry_key_idx"
            );
            const eventPlan = database.sqlite
                .query<QueryPlanRow, [string]>(
                    `
                    EXPLAIN QUERY PLAN
                    SELECT sequence FROM job_run_events
                    WHERE job_run_id = ?
                    ORDER BY sequence DESC LIMIT 50
                `
                )
                .all(uuid(51));
            expect(
                eventPlan.some(({ detail }) => detail.includes("PRIMARY KEY"))
            ).toBeTrue();
            expect(
                eventPlan.some(({ detail }) => detail.includes("USE TEMP B-TREE"))
            ).toBeFalse();
        } finally {
            database.sqlite.close(true);
        }
    });
});
