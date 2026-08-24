import { describe, expect, test } from "bun:test";

import {
    createLogMaintenanceJobQueue,
    LogMaintenanceJobQueueError,
    type LogMaintenanceJobQueueDependencies,
} from "./logMaintenanceQueue.ts";
import type { JobRunRecord } from "./records.ts";
import type { EnqueueManualRunInput, EnqueueManualRunResult } from "./repository.ts";

const idempotencyKey = "log-maintenance-019fdf10-0000-7000-8000-000000000001";

function repositoryFixture() {
    const enqueues: EnqueueManualRunInput[] = [];
    const runs: JobRunRecord[] = [];
    const snapshotBatches: string[][] = [];
    const repository: LogMaintenanceJobQueueDependencies["repository"] = {
        enqueueManualRun(input): Promise<EnqueueManualRunResult> {
            if (input.rejectWhenActionActive === true) {
                const active = runs.find(
                    (run) =>
                        run.actionKey === input.run.actionKey &&
                        (run.state === "queued" || run.state === "running")
                );
                if (active !== undefined) {
                    return Promise.resolve({ kind: "active", run: active });
                }
            }
            enqueues.push(input);
            const stored = {
                ...input.run,
                attemptCount: 0,
                eventBytes: 0,
                eventCount: 1,
                payloadEventCount: 0,
                stateVersion: 1,
            };
            runs.push(stored);
            return Promise.resolve({ kind: "inserted", run: stored });
        },
        findRunByIdempotency(requestedByKind, requestedById, observedKey) {
            return runs.find(
                (run) =>
                    run.requestedByKind === requestedByKind &&
                    run.requestedById === requestedById &&
                    run.idempotencyKey === observedKey
            );
        },
        readActionPayloadRunSnapshots({ actionKey, payloadJsons }) {
            snapshotBatches.push([...payloadJsons]);
            return payloadJsons.map((payloadJson) => {
                const matching = runs
                    .filter(
                        (run) =>
                            run.actionKey === actionKey && run.payloadJson === payloadJson
                    )
                    .toSorted(
                        (left, right) =>
                            Number(right.state === "running") -
                                Number(left.state === "running") ||
                            right.queuedAt.getTime() - left.queuedAt.getTime() ||
                            right.id.localeCompare(left.id)
                    );
                const activeRun = matching.find(
                    ({ state }) => state === "queued" || state === "running"
                );
                const lastRun = matching.find(({ state }) =>
                    ["cancelled", "failed", "succeeded", "timed-out"].includes(state)
                );
                return {
                    ...(activeRun === undefined ? {} : { activeRun }),
                    ...(lastRun === undefined ? {} : { lastRun }),
                    payloadJson,
                };
            });
        },
    };
    return { enqueues, repository, runs, snapshotBatches };
}

describe("log-maintenance durable queue adapter", () => {
    test("atomically describes one path-free fixed-policy run and replays it", async () => {
        const fixture = repositoryFixture();
        const ids = [
            "019fdf10-0000-7000-8000-000000000001",
            "019fdf10-0000-7000-8000-000000000002",
        ];
        let wakeups = 0;
        let availabilityChecks = 0;
        const queue = createLogMaintenanceJobQueue({
            availablePolicies: () => {
                availabilityChecks += 1;
                return Promise.resolve([
                    "host-rsyslog",
                    "unreviewed-policy",
                    "docker-managed",
                    "host-rsyslog",
                ] as never);
            },
            generateId: () => ids.shift() ?? Bun.randomUUIDv7(),
            nowMs: () => 1000,
            repository: fixture.repository,
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        expect(await queue.queueablePolicies()).toEqual([
            "docker-managed",
            "host-rsyslog",
        ]);
        const input = {
            dryRun: false,
            idempotencyKey,
            policyId: "host-rsyslog",
        } as const;
        const first = await queue.enqueue(input);
        const replay = await queue.enqueue(input);

        expect(replay).toEqual(first);
        expect(availabilityChecks).toBe(2);
        expect(wakeups).toBe(1);
        expect(fixture.enqueues).toHaveLength(1);
        expect(fixture.enqueues[0]?.run).toMatchObject({
            actionKey: "maintenance.rotate-logs",
            attemptLimit: 1,
            cancellationPolicy: "cooperative",
            payloadJson: '{"policyId":"host-rsyslog"}',
            requestedById: "system.logs-service",
            requestedByKind: "system",
            resourceClass: "host-heavy",
            resourceKeysJson: '["host.logs"]',
            retrySafe: false,
            scheduledJobId: null,
            triggerType: "system",
        });
        expect(fixture.enqueues[0]?.auditEvents).toMatchObject([
            {
                action: "logs.maintenance.enqueue",
                actorId: "system.logs-service",
                actorKind: "system",
                authenticatorId: null,
                metadataJson: '{"policyId":"host-rsyslog"}',
                outcome: "accepted",
                targetId: first.jobRunId,
                targetType: "job-run",
            },
        ]);
        expect(fixture.enqueues[0]?.realtimeEvents).toHaveLength(1);
        const statuses = await queue.runStatuses();
        expect(
            statuses.find(({ policyId }) => policyId === "host-rsyslog")
        ).toMatchObject({
            activeRun: { id: first.jobRunId, state: "queued" },
            policyId: "host-rsyslog",
        });
        expect(fixture.snapshotBatches).toHaveLength(1);
        expect(fixture.snapshotBatches[0]).toHaveLength(6);

        const activeError = await queue
            .enqueue({
                dryRun: false,
                idempotencyKey: idempotencyKey.replace(/1$/u, "3"),
                policyId: "docker-managed",
            })
            .catch((error: unknown) => error);
        expect(activeError).toBeInstanceOf(LogMaintenanceJobQueueError);
        expect(fixture.enqueues).toHaveLength(1);

        const unavailableError = await queue
            .enqueue({ dryRun: false, idempotencyKey, policyId: "host-apport" })
            .catch((error: unknown) => error);
        expect(unavailableError).toBeInstanceOf(LogMaintenanceJobQueueError);
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("marks every policy unavailable without a worker availability projection", async () => {
        const fixture = repositoryFixture();
        let generatedIds = 0;
        const queue = createLogMaintenanceJobQueue({
            generateId: () => {
                generatedIds += 1;
                return Bun.randomUUIDv7();
            },
            repository: fixture.repository,
        });

        expect(await queue.queueablePolicies()).toEqual([]);
        const unavailableError = await queue
            .enqueue({ dryRun: false, idempotencyKey, policyId: "docker-managed" })
            .catch((error: unknown) => error);
        expect(unavailableError).toBeInstanceOf(LogMaintenanceJobQueueError);
        expect(generatedIds).toBe(0);
        expect(fixture.enqueues).toEqual([]);
    });

    test("fails closed when availability changes to aborted or unavailable", async () => {
        const fixture = repositoryFixture();
        const controller = new AbortController();
        const abortedQueue = createLogMaintenanceJobQueue({
            availablePolicies: () => {
                controller.abort();
                return Promise.resolve(["host-rsyslog"]);
            },
            repository: fixture.repository,
        });
        const unavailableQueue = createLogMaintenanceJobQueue({
            availablePolicies: () => Promise.reject(new Error("private worker state")),
            repository: fixture.repository,
        });

        const failures = await Promise.all([
            abortedQueue
                .queueablePolicies(controller.signal)
                .catch((error: unknown) => error),
            unavailableQueue.queueablePolicies().catch((error: unknown) => error),
        ]);
        expect(failures).toEqual([
            expect.any(LogMaintenanceJobQueueError),
            expect.any(LogMaintenanceJobQueueError),
        ]);
        expect(fixture.enqueues).toEqual([]);
    });

    test("fails closed before persistence for invalid or aborted requests", async () => {
        const fixture = repositoryFixture();
        const queue = createLogMaintenanceJobQueue({ repository: fixture.repository });
        const aborted = AbortSignal.abort();

        const failures = await Promise.all([
            queue.queueablePolicies(aborted).catch((error: unknown) => error),
            queue
                .enqueue(
                    { dryRun: false, idempotencyKey, policyId: "host-rsyslog" },
                    aborted
                )
                .catch((error: unknown) => error),
            queue
                .enqueue({
                    dryRun: false,
                    idempotencyKey,
                    policyId: "/etc/logrotate.d/rsyslog" as never,
                })
                .catch((error: unknown) => error),
        ]);
        expect(failures).toEqual([
            expect.any(LogMaintenanceJobQueueError),
            expect.any(LogMaintenanceJobQueueError),
            expect.any(LogMaintenanceJobQueueError),
        ]);
        expect(fixture.enqueues).toEqual([]);
    });

    test("queues a managed dry-run distinctly and rejects host dry-run input", async () => {
        const fixture = repositoryFixture();
        const queue = createLogMaintenanceJobQueue({
            availablePolicies: () => Promise.resolve(["docker-managed"]),
            generateId: (() => {
                const ids = [
                    "019fdf10-0000-7000-8000-000000000010",
                    "019fdf10-0000-7000-8000-000000000011",
                ];
                return () => ids.shift() ?? Bun.randomUUIDv7();
            })(),
            nowMs: () => 1000,
            repository: fixture.repository,
        });

        const first = await queue.enqueue({
            dryRun: true,
            idempotencyKey,
            policyId: "docker-managed",
        });
        expect(
            await queue.enqueue({
                dryRun: true,
                idempotencyKey,
                policyId: "docker-managed",
            })
        ).toEqual(first);
        expect(fixture.enqueues[0]?.run).toMatchObject({
            displayName: "Managed log maintenance dry-run",
            payloadJson: '{"dryRun":true,"policyId":"docker-managed"}',
        });
        expect(fixture.enqueues[0]?.auditEvents[0]?.metadataJson).toBe(
            '{"dryRun":true,"policyId":"docker-managed"}'
        );
        const activeDryRunStatuses = await queue.runStatuses();
        expect(
            activeDryRunStatuses.find(({ policyId }) => policyId === "docker-managed")
        ).toMatchObject({ activeRun: { id: first.jobRunId, state: "queued" } });

        const dryRunIndex = fixture.runs.findIndex(({ id }) => id === first.jobRunId);
        const dryRunRecord = fixture.runs[dryRunIndex];
        if (dryRunRecord === undefined) throw new Error("Missing dry-run fixture run");
        fixture.runs[dryRunIndex] = {
            ...dryRunRecord,
            eventCount: 2,
            finishedAt: new Date(2000),
            state: "cancelled",
            stateVersion: 2,
            terminalCode: "logs/maintenance-cancelled",
            terminalMessage: "Log maintenance was cancelled.",
            updatedAt: new Date(2000),
        };
        const terminalDryRunStatuses = await queue.runStatuses();
        const terminalDryRunStatus = terminalDryRunStatuses.find(
            ({ policyId }) => policyId === "docker-managed"
        );
        expect(terminalDryRunStatus?.activeRun).toBeUndefined();
        expect(terminalDryRunStatus?.lastRun).toBeUndefined();

        const modeMismatch = await queue
            .enqueue({
                dryRun: false,
                idempotencyKey,
                policyId: "docker-managed",
            })
            .catch((error: unknown) => error);
        expect(modeMismatch).toBeInstanceOf(LogMaintenanceJobQueueError);

        const rejected = await queue
            .enqueue({
                dryRun: true,
                idempotencyKey: `${idempotencyKey}-host`,
                policyId: "host-rsyslog",
            })
            .catch((error: unknown) => error);
        expect(rejected).toBeInstanceOf(LogMaintenanceJobQueueError);
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("rejects a same-key dry-run after a real managed request", async () => {
        const fixture = repositoryFixture();
        const queue = createLogMaintenanceJobQueue({
            availablePolicies: () => Promise.resolve(["docker-managed"]),
            repository: fixture.repository,
        });
        const reverseKey = idempotencyKey.replace(/1$/u, "4");

        await queue.enqueue({
            dryRun: false,
            idempotencyKey: reverseKey,
            policyId: "docker-managed",
        });
        const mismatch = await queue
            .enqueue({
                dryRun: true,
                idempotencyKey: reverseKey,
                policyId: "docker-managed",
            })
            .catch((error: unknown) => error);

        expect(mismatch).toBeInstanceOf(LogMaintenanceJobQueueError);
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("keeps a new active real run separate from the latest terminal real run", async () => {
        const fixture = repositoryFixture();
        const ids = [
            "019fdf10-0000-7000-8000-000000000020",
            "019fdf10-0000-7000-8000-000000000021",
            "019fdf10-0000-7000-8000-000000000022",
            "019fdf10-0000-7000-8000-000000000023",
        ];
        let nowMs = 1000;
        const queue = createLogMaintenanceJobQueue({
            availablePolicies: () => Promise.resolve(["docker-managed"]),
            generateId: () => ids.shift() ?? Bun.randomUUIDv7(),
            nowMs: () => nowMs,
            repository: fixture.repository,
        });
        const first = await queue.enqueue({
            dryRun: false,
            idempotencyKey,
            policyId: "docker-managed",
        });
        const summary = {
            actionCounts: {
                compressed: 1,
                deleted: 2,
                error: 0,
                missing: 0,
                rotated: 3,
                skipped: 4,
            },
            checkedTargets: 10,
            dryRun: false,
            finishedAtMs: 3000,
            ok: true,
            startedAtMs: 2000,
        } as const;
        const firstIndex = fixture.runs.findIndex(({ id }) => id === first.jobRunId);
        const firstRun = fixture.runs[firstIndex];
        if (firstRun === undefined) throw new Error("Missing first fixture run");
        fixture.runs[firstIndex] = {
            ...firstRun,
            attemptCount: 1,
            eventCount: 3,
            finishedAt: new Date(3000),
            firstStartedAt: new Date(2000),
            lastAttemptStartedAt: new Date(2000),
            resultJson: JSON.stringify({
                completedAtMs: 3000,
                dryRun: false,
                policyId: "docker-managed",
                status: "completed",
                summary,
            }),
            state: "succeeded",
            stateVersion: 3,
            updatedAt: new Date(3000),
        };

        nowMs = 4000;
        const active = await queue.enqueue({
            dryRun: false,
            idempotencyKey: idempotencyKey.replace(/1$/u, "2"),
            policyId: "docker-managed",
        });
        const statuses = await queue.runStatuses();
        const status = statuses.find(({ policyId }) => policyId === "docker-managed");

        expect(status).toMatchObject({
            activeRun: { id: active.jobRunId, state: "queued" },
            lastRun: {
                run: { id: first.jobRunId, state: "succeeded" },
            },
            policyId: "docker-managed",
        });
        expect(status?.lastRun?.summary).toMatchObject({
            checkedTargets: 10,
            dryRun: false,
            ok: true,
        });

        const succeededRun = fixture.runs[firstIndex];
        if (succeededRun === undefined) {
            throw new Error("Missing succeeded fixture run");
        }
        fixture.runs[firstIndex] = {
            ...succeededRun,
            resultJson: '{"unexpected":true}',
        };
        const updatedStatuses = await queue.runStatuses();
        const invalidResultStatus = updatedStatuses.find(
            ({ policyId }) => policyId === "docker-managed"
        );
        expect(invalidResultStatus?.lastRun?.summary).toBeUndefined();
    });
});
