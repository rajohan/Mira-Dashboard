import { describe, expect, test } from "bun:test";

import { backupKopiaRunJobActionDefinition } from "../jobs/actionRegistry.ts";
import type { EnqueueManualRunInput } from "../jobs/repository.ts";
import { createBackupOperationQueue } from "./operationQueue.ts";

const actor = Object.freeze({
    authenticatorId: "019fe200-0000-7000-8000-000000000001",
    id: "019fe200-0000-7000-8000-000000000002",
    kind: "user" as const,
});

describe("backup operation queue", () => {
    test("associates a manual provider run with its owning schedule", async () => {
        let captured: EnqueueManualRunInput | undefined;
        const queue = createBackupOperationQueue({
            generateId: (() => {
                const ids = [
                    "019fe200-0000-7000-8000-000000000010",
                    "019fe200-0000-7000-8000-000000000011",
                ];
                return () => ids.shift()!;
            })(),
            nowMs: () => 1000,
            repository: {
                enqueueManualRun: (input) => {
                    captured = input;
                    return Promise.resolve({
                        kind: "inserted",
                        run: {
                            ...input.run,
                            attemptCount: 0,
                            eventBytes: 0,
                            eventCount: 1,
                            payloadEventCount: 0,
                            requiredWorkerReleaseId:
                                input.run.requiredWorkerReleaseId ?? null,
                            stateVersion: 1,
                        },
                    });
                },
                findRunByIdempotency: () => {},
                findSchedule: (id) =>
                    ({
                        schedule: {
                            actionKey: backupKopiaRunJobActionDefinition.actionKey,
                            id,
                            version: 4,
                        },
                    }) as never,
            },
            requiredWorkerReleaseId: "a".repeat(40),
        });

        await queue.enqueue({
            actor,
            authorizeDispatch: () =>
                Promise.resolve({
                    authorize: () => {},
                    payload: {
                        operation: "run",
                        sourceRevision: "b".repeat(64),
                        trigger: "manual",
                        type: "kopia",
                    },
                }),
            input: {
                confirmation: "run-kopia-backup",
                idempotencyKey:
                    "cHJvZHVjdGlvbi1iYWNrdXAtc2NoZWR1bGUtYXNzb2NpYXRpb24ta2V5",
                operation: "run",
                sourceRevision: "b".repeat(64),
                type: "kopia",
            },
            requestId: "019fe200-0000-7000-8000-000000000012",
        });

        expect(captured?.run).toMatchObject({
            scheduledJobId: backupKopiaRunJobActionDefinition.scheduleId,
            scheduledJobVersion: 4,
            triggerType: "manual",
        });
        expect(captured?.realtimeEvents).toHaveLength(2);
        expect(captured?.realtimeEvents[1]).toMatchObject({
            entityId: backupKopiaRunJobActionDefinition.scheduleId,
            entityType: "schedule",
            operation: "updated",
        });
    });

    test("reports unknown outcome when post-enqueue durable recovery is unavailable", () => {
        let reads = 0;
        const queue = createBackupOperationQueue({
            repository: {
                enqueueManualRun: () => Promise.reject(new Error("commit unknown")),
                findRunByIdempotency: () => {
                    reads += 1;
                    if (reads === 1) return;
                    throw new Error("recovery unavailable");
                },
                findSchedule: (id) =>
                    id === backupKopiaRunJobActionDefinition.scheduleId
                        ? ({
                              schedule: {
                                  actionKey: backupKopiaRunJobActionDefinition.actionKey,
                                  id,
                                  version: 3,
                              },
                          } as never)
                        : undefined,
            },
            requiredWorkerReleaseId: "a".repeat(40),
        });

        expect(
            queue.enqueue({
                actor,
                authorizeDispatch: () =>
                    Promise.resolve({
                        authorize: () => {},
                        payload: {
                            operation: "run",
                            sourceRevision: "b".repeat(64),
                            trigger: "manual",
                            type: "kopia",
                        },
                    }),
                input: {
                    confirmation: "run-kopia-backup",
                    idempotencyKey: "cHJvZHVjdGlvbi1iYWNrdXAtdW5rbm93bi1vdXRjb21lLWtleQ",
                    operation: "run",
                    sourceRevision: "b".repeat(64),
                    type: "kopia",
                },
                requestId: "019fe200-0000-7000-8000-000000000003",
            })
        ).rejects.toMatchObject({ reason: "unknown-outcome" });
    });
});
