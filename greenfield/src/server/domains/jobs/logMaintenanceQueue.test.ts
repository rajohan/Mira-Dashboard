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
        const queue = createLogMaintenanceJobQueue({
            generateId: () => ids.shift() ?? Bun.randomUUIDv7(),
            nowMs: () => 1000,
            repository: fixture.repository,
            wakeEventPump: () => {
                wakeups += 1;
            },
        });

        expect(await queue.queueablePolicies()).toEqual([
            "docker-managed",
            "host-alternatives",
            "host-apport",
            "host-dpkg",
            "host-rsyslog",
        ]);
        const input = { idempotencyKey, policyId: "host-rsyslog" } as const;
        const first = await queue.enqueue(input);
        const replay = await queue.enqueue(input);

        expect(replay).toEqual(first);
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

        expect(
            queue.enqueue({ idempotencyKey, policyId: "host-apport" })
        ).rejects.toBeInstanceOf(LogMaintenanceJobQueueError);
        expect(fixture.enqueues).toHaveLength(1);
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
