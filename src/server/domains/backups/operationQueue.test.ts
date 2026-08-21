import { describe, expect, test } from "bun:test";

import { createBackupOperationQueue } from "./operationQueue.ts";

const actor = Object.freeze({
    authenticatorId: "019fe200-0000-7000-8000-000000000001",
    id: "019fe200-0000-7000-8000-000000000002",
    kind: "user" as const,
});

describe("backup operation queue", () => {
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
