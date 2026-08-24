import { describe, expect, test } from "bun:test";

import { captureFailure } from "../../test/support/promise.ts";
import {
    dockerOperationJobActionKey,
    dockerUpdaterJobActionKey,
} from "../jobs/actionRegistry.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type {
    EnqueueManualRunInput,
    EnqueueManualRunResult,
} from "../jobs/repository.ts";
import {
    createDockerOperationQueue,
    DockerOperationQueueError,
    type DockerOperationQueueDependencies,
    type DockerOperationQueueRequest,
} from "./operationQueue.ts";

const actor = Object.freeze({
    authenticatorId: "018f6f50-6a9e-7b88-8000-000000000010",
    id: "018f6f50-6a9e-7b88-8000-000000000011",
    kind: "user" as const,
});
const sourceRevision = "d".repeat(64);
const idempotencyKey = "A".repeat(43);
const requiredWorkerReleaseId = "b".repeat(40);

function repositoryFixture() {
    const enqueues: EnqueueManualRunInput[] = [];
    let activeConflict = false;
    let admittedReplay = false;
    let stored: JobRunRecord | undefined;
    const repository: DockerOperationQueueDependencies["repository"] = {
        enqueueManualRun(input, authorize): Promise<EnqueueManualRunResult> {
            authorize?.();
            if (activeConflict && stored !== undefined) {
                return Promise.resolve({ kind: "active", run: stored });
            }
            stored = {
                ...input.run,
                attemptCount: 0,
                eventBytes: 0,
                eventCount: 1,
                payloadEventCount: 0,
                requiredWorkerReleaseId: input.run.requiredWorkerReleaseId ?? null,
                stateVersion: 1,
            };
            if (admittedReplay) {
                return Promise.resolve({ kind: "replayed", run: stored });
            }
            enqueues.push(input);
            return Promise.resolve({ kind: "inserted", run: stored });
        },
        findRunByIdempotency(kind, id, key) {
            return stored?.requestedByKind === kind &&
                stored.requestedById === id &&
                stored.idempotencyKey === key
                ? stored
                : undefined;
        },
    };
    return {
        enqueues,
        repository,
        setActiveConflict(value: boolean) {
            activeConflict = value;
        },
        setAdmittedReplay(value: boolean) {
            admittedReplay = value;
        },
    };
}

function stackRequest(
    overrides: Partial<DockerOperationQueueRequest> = {}
): DockerOperationQueueRequest {
    return {
        actor,
        authorizeDispatch: () =>
            Promise.resolve({
                authorize: () => {},
                onAccepted: () => {},
                payload: {
                    operation: "stack-restart",
                    sourceRevision,
                },
            }),
        input: {
            confirmation: "restart-docker-stack",
            idempotencyKey,
            operation: "stack-restart",
            sourceRevision,
        },
        requestId: "request-1",
        ...overrides,
    };
}

function queueFixture(
    repository = repositoryFixture(),
    overrides: Partial<DockerOperationQueueDependencies> = {}
) {
    const ids = [
        "018f6f50-6a9e-7b88-8000-000000000020",
        "018f6f50-6a9e-7b88-8000-000000000021",
        "018f6f50-6a9e-7b88-8000-000000000022",
        "018f6f50-6a9e-7b88-8000-000000000023",
    ];
    return {
        queue: createDockerOperationQueue({
            generateId: () => ids.shift()!,
            nowMs: () => 1000,
            repository: repository.repository,
            requiredWorkerReleaseId,
            ...overrides,
        }),
        repository,
    };
}

describe("Docker operation queue", () => {
    test("queues a source-bound payload and reauthorizes inside admitted enqueue", async () => {
        const fixture = queueFixture();
        let authorizationChecks = 0;
        let accepted = 0;
        const result = await fixture.queue.enqueue(
            stackRequest({
                authorizeDispatch: () =>
                    Promise.resolve({
                        authorize: () => {
                            authorizationChecks += 1;
                            expect(fixture.repository.enqueues).toHaveLength(0);
                        },
                        onAccepted: () => {
                            accepted += 1;
                            expect(fixture.repository.enqueues).toHaveLength(1);
                        },
                        payload: {
                            operation: "stack-restart",
                            sourceRevision,
                        },
                    }),
            })
        );

        expect(result).toEqual({
            jobRunId: "018f6f50-6a9e-7b88-8000-000000000020",
            operation: "stack-restart",
            queued: true,
        });
        expect(authorizationChecks).toBe(1);
        expect(accepted).toBe(1);
        expect(fixture.repository.enqueues).toHaveLength(1);
        expect(fixture.repository.enqueues[0]).toMatchObject({
            rejectWhenActionActive: true,
            run: {
                actionKey: dockerOperationJobActionKey,
                idempotencyKey,
                payloadJson: JSON.stringify({
                    operation: "stack-restart",
                    sourceRevision,
                }),
                requiredWorkerReleaseId,
                resourceClass: "exclusive",
                triggerType: "manual",
            },
        });
        expect(fixture.repository.enqueues[0]?.auditEvents).toMatchObject([
            {
                action: "docker.operation.enqueue",
                actorId: actor.id,
                authenticatorId: actor.authenticatorId,
                outcome: "accepted",
                requestId: "request-1",
            },
        ]);
    });

    test("uses the updater action for every updater operation", async () => {
        for (const [operation, confirmation] of [
            ["updater-run", "run-docker-updates"],
            ["updater-scan", "scan-docker-updates"],
        ] as const) {
            const fixture = queueFixture();
            await fixture.queue.enqueue({
                ...stackRequest(),
                authorizeDispatch: () =>
                    Promise.resolve({
                        authorize: () => {},
                        onAccepted: () => {},
                        payload: { operation, sourceRevision },
                    }),
                input: {
                    confirmation,
                    idempotencyKey,
                    operation,
                    sourceRevision,
                } as never,
            });
            expect(fixture.repository.enqueues[0]?.run.actionKey).toBe(
                dockerUpdaterJobActionKey
            );
        }
    });

    test("persists and replay-matches the exact service image fence", async () => {
        const fixture = queueFixture();
        const input = {
            candidateImage: "ghcr.io/example/app:1.1.0",
            confirmation: "update-docker-service" as const,
            currentImage: "ghcr.io/example/app:1.0.0",
            idempotencyKey,
            operation: "updater-update-service" as const,
            serviceId: "e".repeat(64),
            sourceRevision,
        };
        const payload = {
            candidateImage: input.candidateImage,
            currentImage: input.currentImage,
            operation: input.operation,
            serviceId: input.serviceId,
            sourceRevision,
        };
        const request = {
            ...stackRequest(),
            authorizeDispatch: () =>
                Promise.resolve({
                    authorize: () => {},
                    onAccepted: () => {},
                    payload,
                }),
            input,
        };

        const first = await fixture.queue.enqueue(request);
        expect(fixture.repository.enqueues[0]?.run).toMatchObject({
            actionKey: dockerUpdaterJobActionKey,
            payloadJson: JSON.stringify(payload),
        });
        expect(await fixture.queue.enqueue(request)).toEqual(first);

        expect(
            await captureFailure(() =>
                fixture.queue.enqueue({
                    ...request,
                    input: {
                        ...input,
                        candidateImage: "ghcr.io/example/app:1.2.0",
                    },
                })
            )
        ).toMatchObject({ reason: "conflict" });
    });

    test("returns exact replays without reauthorization and rejects mismatches", async () => {
        const fixture = queueFixture();
        const first = await fixture.queue.enqueue(stackRequest());
        let authorizations = 0;
        const replay = await fixture.queue.enqueue(
            stackRequest({
                authorizeDispatch: () => {
                    authorizations += 1;
                    throw new Error("must not run");
                },
            })
        );
        expect(replay).toEqual(first);
        expect(authorizations).toBe(0);
        expect(fixture.repository.enqueues).toHaveLength(1);

        expect(
            await captureFailure(() =>
                fixture.queue.enqueue({
                    ...stackRequest(),
                    authorizeDispatch: () =>
                        Promise.resolve({
                            authorize: () => {},
                            onAccepted: () => {},
                            payload: { operation: "stack-stop", sourceRevision },
                        }),
                    input: {
                        confirmation: "stop-docker-stack",
                        idempotencyKey,
                        operation: "stack-stop",
                        sourceRevision,
                    },
                })
            )
        ).toBeInstanceOf(DockerOperationQueueError);
    });

    test("rejects an active same-action mutation and missing worker release", async () => {
        const fixture = queueFixture();
        await fixture.queue.enqueue(stackRequest());
        fixture.repository.setActiveConflict(true);
        let accepted = 0;
        expect(
            await captureFailure(() =>
                fixture.queue.enqueue(
                    stackRequest({
                        authorizeDispatch: () =>
                            Promise.resolve({
                                authorize: () => {},
                                onAccepted: () => {
                                    accepted += 1;
                                },
                                payload: {
                                    operation: "stack-restart",
                                    sourceRevision,
                                },
                            }),
                        input: {
                            confirmation: "restart-docker-stack",
                            idempotencyKey: `${"A".repeat(42)}Q`,
                            operation: "stack-restart",
                            sourceRevision,
                        },
                    })
                )
            )
        ).toMatchObject({ reason: "conflict" });
        expect(accepted).toBe(0);

        const unavailable = createDockerOperationQueue({
            repository: repositoryFixture().repository,
        });
        expect(
            await captureFailure(() => unavailable.enqueue(stackRequest()))
        ).toMatchObject({ reason: "unavailable" });
    });

    test("finalizes one-time authority for an exact replay admitted by the repository", async () => {
        const fixture = queueFixture();
        fixture.repository.setAdmittedReplay(true);
        let accepted = 0;

        expect(
            await fixture.queue.enqueue(
                stackRequest({
                    authorizeDispatch: () =>
                        Promise.resolve({
                            authorize: () => {},
                            onAccepted: () => {
                                accepted += 1;
                            },
                            payload: {
                                operation: "stack-restart",
                                sourceRevision,
                            },
                        }),
                })
            )
        ).toMatchObject({ operation: "stack-restart", queued: true });
        expect(accepted).toBe(1);
        expect(fixture.repository.enqueues).toHaveLength(0);
    });

    test("does not include raw repository diagnostics in serialized failures", async () => {
        const fixture = queueFixture(repositoryFixture(), {
            repository: {
                enqueueManualRun: () =>
                    Promise.reject(new Error("SECRET docker diagnostic")),
                findRunByIdempotency: () => {},
            },
        });
        const failure = await fixture.queue
            .enqueue(stackRequest())
            .catch((error: unknown) => error);
        expect(failure).toMatchObject({ reason: "unknown-outcome" });
        expect(JSON.stringify(failure)).not.toContain("SECRET docker diagnostic");
    });
});
