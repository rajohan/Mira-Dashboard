import { describe, expect, test } from "bun:test";

import type { JobRunRecord } from "../jobs/records.ts";
import type {
    EnqueueManualRunInput,
    EnqueueManualRunResult,
} from "../jobs/repository.ts";
import { WorkspaceFileError } from "./errors.ts";
import { parseWorkspaceFileJobPayload } from "./jobPayload.ts";
import {
    createWorkspaceFileJobScheduler,
    type WorkspaceFileJobSchedulerDependencies,
} from "./jobScheduler.ts";
import type {
    WorkspaceFileWriteAuditContext,
    WorkspaceFileWriteCommand,
} from "./ports.ts";

const ticketId = "019fdf50-0000-4000-8000-000000000001";
const spoolId = "019fdf50-0000-4000-8000-000000000002";
const actor = Object.freeze({
    authenticatorId: "019fdf50-0000-7000-8000-000000000010",
    id: "019fdf50-0000-7000-8000-000000000011",
    kind: "user" as const,
});
const audit: WorkspaceFileWriteAuditContext = Object.freeze({
    actor,
    requestId: "019fdf50-0000-7000-8000-000000000012",
});
const command: WorkspaceFileWriteCommand = Object.freeze({
    fileName: "notes.txt",
    locator: Object.freeze({ rootId: "workspace", segments: Object.freeze([]) }),
    mimeType: "text/plain",
    operation: "create",
    sha256: "a".repeat(64),
    sizeBytes: 12,
    spoolId,
    ticketId,
});

function repositoryFixture() {
    const enqueues: EnqueueManualRunInput[] = [];
    let stored: JobRunRecord | undefined;
    const repository: WorkspaceFileJobSchedulerDependencies["repository"] = {
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
        listActiveActionPayloads() {
            return { payloads: [], truncated: false };
        },
    };
    return { enqueues, repository };
}

describe("workspace file durable job scheduler", () => {
    test("atomically audits one actor-bound unscheduled write and replays it", async () => {
        const fixture = repositoryFixture();
        const ids = [
            "019fdf50-0000-7000-8000-000000000020",
            "019fdf50-0000-7000-8000-000000000021",
        ];
        let wakeups = 0;
        const scheduler = createWorkspaceFileJobScheduler({
            generateId: () => ids.shift() ?? Bun.randomUUIDv7(),
            nowMs: () => 1000,
            repository: fixture.repository,
            wakeEventPump: () => {
                wakeups += 1;
                throw new Error("wake delivery is best effort after commit");
            },
        });

        const first = await scheduler.enqueue(command, audit);
        const replay = await scheduler.enqueue(command, audit);

        expect(replay).toEqual(first);
        expect(first).toEqual({
            acceptedAtMs: 1000,
            jobRunId: "019fdf50-0000-7000-8000-000000000020",
            ticketId,
        });
        expect(wakeups).toBe(1);
        expect(fixture.enqueues).toHaveLength(1);
        const enqueue = fixture.enqueues[0]!;
        expect(enqueue.run).toMatchObject({
            actionKey: "workspace-files.apply-write",
            idempotencyKey: ticketId,
            requestedById: actor.id,
            requestedByKind: "user",
            scheduledForAt: null,
            scheduledJobId: null,
            scheduledJobVersion: null,
            triggerType: "manual",
        });
        const payload = parseWorkspaceFileJobPayload(
            JSON.parse(enqueue.run.payloadJson) as unknown
        );
        expect(payload.command).toEqual(command);
        expect(payload.actorBindingSha256).toMatch(/^[0-9a-f]{64}$/u);
        expect(enqueue.run.payloadJson).not.toContain(actor.authenticatorId);
        expect(enqueue.auditEvents).toMatchObject([
            {
                action: "files.write.enqueue",
                actorId: actor.id,
                actorKind: "user",
                authenticatorId: actor.authenticatorId,
                metadataJson: '{"operation":"create"}',
                outcome: "accepted",
                requestId: audit.requestId,
                targetId: first.jobRunId,
                targetType: "job-run",
            },
        ]);
        expect(enqueue.realtimeEvents).toHaveLength(1);
        expect(await scheduler.getStatus(ticketId, actor)).toEqual({
            jobRunId: first.jobRunId,
            status: "accepted",
            ticketId,
        });
        expect(
            await scheduler.getStatus(ticketId, {
                ...actor,
                authenticatorId: "019fdf50-0000-7000-8000-000000000099",
            })
        ).toBeUndefined();
    });

    test("fails closed for ticket reuse, invalid payloads, and cancellation", async () => {
        const fixture = repositoryFixture();
        const scheduler = createWorkspaceFileJobScheduler({
            repository: fixture.repository,
        });
        await scheduler.enqueue(command, audit);

        expect(
            scheduler.enqueue({ ...command, sha256: "b".repeat(64) }, audit)
        ).rejects.toBeInstanceOf(WorkspaceFileError);
        expect(
            scheduler.enqueue(
                { ...command, locator: { rootId: "workspace", segments: [".."] } },
                audit
            )
        ).rejects.toBeInstanceOf(WorkspaceFileError);
        expect(
            createWorkspaceFileJobScheduler({
                repository: repositoryFixture().repository,
            }).enqueue(command, audit, AbortSignal.abort())
        ).rejects.toBeInstanceOf(WorkspaceFileError);
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("queues replacements under the retry-safe recovery action only", async () => {
        const fixture = repositoryFixture();
        const scheduler = createWorkspaceFileJobScheduler({
            repository: fixture.repository,
        });
        await scheduler.enqueue(
            {
                ...command,
                expectedRevision: "b".repeat(64),
                locator: {
                    rootId: "workspace",
                    segments: [command.fileName],
                },
                operation: "replace",
            },
            audit
        );

        expect(fixture.enqueues[0]?.run).toMatchObject({
            actionKey: "workspace-files.apply-replacement",
            attemptLimit: 3,
            retrySafe: true,
        });
    });

    test("reconciles bounded active spool identities and fails closed on durable corruption", async () => {
        const fixture = repositoryFixture();
        fixture.repository.listActiveActionPayloads = () => ({
            payloads: [
                JSON.stringify({
                    actorBindingSha256: "a".repeat(64),
                    command,
                }),
                JSON.stringify({
                    actorBindingSha256: "b".repeat(64),
                    command,
                }),
            ],
            truncated: false,
        });
        const scheduler = createWorkspaceFileJobScheduler({
            repository: fixture.repository,
        });

        expect(await scheduler.listActiveSpoolIds()).toEqual({
            spoolIds: [spoolId],
            truncated: false,
        });

        fixture.repository.listActiveActionPayloads = () => ({
            payloads: ["{}"],
            truncated: false,
        });
        expect(scheduler.listActiveSpoolIds()).rejects.toMatchObject({
            reason: "unavailable",
        });
    });
});
