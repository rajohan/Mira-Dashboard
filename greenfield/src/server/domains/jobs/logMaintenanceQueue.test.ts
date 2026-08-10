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
    let stored: JobRunRecord | undefined;
    const repository: LogMaintenanceJobQueueDependencies["repository"] = {
        enqueueManualRun(input): Promise<EnqueueManualRunResult> {
            enqueues.push(input);
            stored = {
                ...input.run,
                attemptCount: 0,
                eventBytes: 0,
                eventCount: 1,
                payloadEventCount: 0,
                stateVersion: 1,
            };
            return Promise.resolve({ kind: "inserted", run: stored });
        },
        findRunByIdempotency(requestedByKind, requestedById, observedKey) {
            return stored?.requestedByKind === requestedByKind &&
                stored.requestedById === requestedById &&
                stored.idempotencyKey === observedKey
                ? stored
                : undefined;
        },
    };
    return { enqueues, repository };
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
        const input = { idempotencyKey, policyId: "host-rsyslog" } as const;
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

        const unavailableError = await queue
            .enqueue({ idempotencyKey, policyId: "host-apport" })
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
            .enqueue({ idempotencyKey, policyId: "docker-managed" })
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
                .enqueue({ idempotencyKey, policyId: "host-rsyslog" }, aborted)
                .catch((error: unknown) => error),
            queue
                .enqueue({
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
});
