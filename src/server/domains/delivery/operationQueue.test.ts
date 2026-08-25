import { describe, expect, test } from "bun:test";

import { publishedReleaseAuthority } from "../../../testSupport/publishedReleaseAuthority.ts";
import type { JobRunRecord } from "../jobs/records.ts";
import type {
    EnqueueManualRunInput,
    EnqueueManualRunResult,
} from "../jobs/repository.ts";
import {
    createDeliveryOperationQueue,
    DeliveryOperationQueueError,
    type DeliveryOperationQueueDependencies,
} from "./operationQueue.ts";

const actor = Object.freeze({
    authenticatorId: "018f6f50-6a9e-7b88-8000-000000000010",
    id: "018f6f50-6a9e-7b88-8000-000000000011",
    kind: "user" as const,
});
const sourceRevision = "a".repeat(64);
const headSha = "b".repeat(40);
const idempotencyKey = "A".repeat(43);

function repositoryFixture() {
    const enqueues: EnqueueManualRunInput[] = [];
    let stored: JobRunRecord | undefined;
    const repository: DeliveryOperationQueueDependencies["repository"] = {
        enqueueManualRun(input, authorize): Promise<EnqueueManualRunResult> {
            authorize?.();
            stored = {
                ...input.run,
                attemptCount: 0,
                eventBytes: 0,
                eventCount: 1,
                payloadEventCount: 0,
                requiredWorkerReleaseId: input.run.requiredWorkerReleaseId ?? null,
                stateVersion: 1,
            };
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
    return { enqueues, repository };
}

function definitions(): DeliveryOperationQueueDependencies["actionDefinitions"] {
    return {
        "delivery.github": {
            actionKey: "delivery.github",
            attemptLimit: 1,
            cancellationPolicy: "never",
            displayName: "Delivery GitHub operation",
            priority: 50,
            resourceClass: "network",
            resourceKeys: ["delivery.github"],
            retrySafe: false,
            timeoutMs: 600_000,
        },
        "delivery.preview": {
            actionKey: "delivery.preview",
            attemptLimit: 1,
            cancellationPolicy: "never",
            displayName: "Delivery preview operation",
            priority: 50,
            resourceClass: "exclusive",
            resourceKeys: ["delivery.preview"],
            retrySafe: false,
            timeoutMs: 1_800_000,
        },
        "delivery.production.v1": {
            actionKey: "delivery.production.v1",
            attemptLimit: 3,
            cancellationPolicy: "never",
            displayName: "Delivery production operation",
            priority: 100,
            resourceClass: "exclusive",
            resourceKeys: ["delivery.production"],
            retrySafe: true,
            timeoutMs: 2_700_000,
        },
    };
}

function queueFixture() {
    const fixture = repositoryFixture();
    const ids = [
        "018f6f50-6a9e-7b88-8000-000000000020",
        "018f6f50-6a9e-7b88-8000-000000000021",
    ];
    return {
        ...fixture,
        queue: createDeliveryOperationQueue({
            actionDefinitions: definitions(),
            generateId: () => ids.shift()!,
            nowMs: () => 1000,
            repository: fixture.repository,
            requiredWorkerReleaseId: (actionKey) =>
                actionKey === "delivery.production.v1" ? null : "c".repeat(40),
        }),
    };
}

function deployRequest(authorize: () => void = () => {}) {
    return {
        actor,
        authorizeDispatch: () =>
            Promise.resolve({
                authorize,
                payload: {
                    activationRevision: sourceRevision,
                    checkoutRevision: sourceRevision,
                    expectedMainHeadSha: headSha,
                    operation: "deploy" as const,
                    release: publishedReleaseAuthority(headSha),
                    sourceRevision,
                },
            }),
        input: {
            activationRevision: sourceRevision,
            checkoutRevision: sourceRevision,
            confirmation: "deploy-delivery-main" as const,
            expectedMainHeadSha: headSha,
            idempotencyKey,
            operation: "deploy" as const,
            release: publishedReleaseAuthority(headSha),
            sourceRevision,
        },
        requestId: "request-1",
    };
}

describe("Delivery operation queue", () => {
    test("queues versioned production work with cross-release protocol fencing", async () => {
        const fixture = queueFixture();
        let authorizations = 0;
        const result = await fixture.queue.enqueue(
            deployRequest(() => {
                authorizations += 1;
            })
        );
        expect(result).toMatchObject({ operation: "deploy", queued: true });
        expect(authorizations).toBe(1);
        expect(fixture.enqueues[0]?.run).toMatchObject({
            actionKey: "delivery.production.v1",
            requiredWorkerReleaseId: null,
            retrySafe: true,
        });
        expect(JSON.parse(fixture.enqueues[0]!.run.payloadJson)).toEqual({
            activationRevision: sourceRevision,
            checkoutRevision: sourceRevision,
            expectedMainHeadSha: headSha,
            operation: "deploy",
            release: publishedReleaseAuthority(headSha),
            sourceRevision,
        });
    });

    test("returns an exact idempotent replay before fresh source authorization", async () => {
        const fixture = queueFixture();
        const first = await fixture.queue.enqueue(deployRequest());
        const replay = await fixture.queue.enqueue({
            ...deployRequest(),
            authorizeDispatch: () => {
                throw new Error("must not authorize an exact replay");
            },
        });
        expect(replay).toEqual(first);
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("fails closed when a payload does not match the confirmed request", async () => {
        const fixture = queueFixture();
        try {
            await fixture.queue.enqueue({
                ...deployRequest(),
                authorizeDispatch: () =>
                    Promise.resolve({
                        authorize: () => {},
                        payload: {
                            activationRevision: sourceRevision,
                            checkoutRevision: sourceRevision,
                            expectedMainHeadSha: "d".repeat(40),
                            operation: "deploy" as const,
                            release: publishedReleaseAuthority("d".repeat(40)),
                            sourceRevision,
                        },
                    }),
            });
            throw new Error("expected queue conflict");
        } catch (error) {
            expect(error).toBeInstanceOf(DeliveryOperationQueueError);
            expect((error as DeliveryOperationQueueError).reason).toBe("conflict");
        }
        expect(fixture.enqueues).toHaveLength(0);
    });

    test("rejects dispatch whose release authority differs from the confirmed input", async () => {
        const fixture = queueFixture();
        const request = deployRequest();
        const differentRelease = {
            ...publishedReleaseAuthority(headSha),
            releaseManifestSha256: "0".repeat(64),
        };
        try {
            await fixture.queue.enqueue({
                ...request,
                authorizeDispatch: () =>
                    Promise.resolve({
                        authorize: () => {},
                        payload: {
                            activationRevision: sourceRevision,
                            checkoutRevision: sourceRevision,
                            expectedMainHeadSha: headSha,
                            operation: "deploy" as const,
                            release: differentRelease,
                            sourceRevision,
                        },
                    }),
            });
            throw new Error("expected queue conflict");
        } catch (error) {
            expect(error).toBeInstanceOf(DeliveryOperationQueueError);
            expect((error as DeliveryOperationQueueError).reason).toBe("conflict");
        }
        expect(fixture.enqueues).toHaveLength(0);
    });
});
