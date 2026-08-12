import { describe, expect, test } from "bun:test";

import {
    type ServiceActionId,
    serviceActionIds,
} from "../../../contracts/serviceActions.ts";
import type { JobUnscheduledActionDefinition } from "./actionRegistry.ts";
import type { JobRunRecord } from "./records.ts";
import type { EnqueueManualRunInput, EnqueueManualRunResult } from "./repository.ts";
import {
    createServiceActionQueue,
    serviceActionJobActionKeys,
    ServiceActionQueueError,
    type ServiceActionQueueDependencies,
    type ServiceActionQueueRequest,
} from "./serviceActionQueue.ts";

const actor = Object.freeze({
    authenticatorId: "019fdf50-0000-7000-8000-000000000010",
    id: "019fdf50-0000-7000-8000-000000000011",
    kind: "user" as const,
});
const idempotencyKey = "019fdf50-0000-4000-8000-000000000012";

function definition(actionId: ServiceActionId): JobUnscheduledActionDefinition {
    return Object.freeze({
        actionKey: serviceActionJobActionKeys[actionId],
        attemptLimit: 1,
        cancellationPolicy: "never",
        description: `Runs ${actionId}.`,
        displayName: actionId,
        manualExposure: "none",
        priority: 20,
        resourceClass: "exclusive",
        resourceKeys: Object.freeze(["host.mutation", actionId]),
        retrySafe: false,
        timeoutMs: 60_000,
    });
}

const definitions = Object.freeze(
    Object.fromEntries(
        serviceActionIds.map((actionId) => [actionId, definition(actionId)])
    ) as Record<ServiceActionId, JobUnscheduledActionDefinition>
);

function repositoryFixture() {
    const enqueues: EnqueueManualRunInput[] = [];
    const idempotencyReads: [JobRunRecord["requestedByKind"], string, string][] = [];
    let stored: JobRunRecord | undefined;
    const repository: ServiceActionQueueDependencies["repository"] = {
        enqueueManualRun(input, beforeInsert): Promise<EnqueueManualRunResult> {
            beforeInsert?.();
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
            idempotencyReads.push([requestedByKind, requestedById, observedKey]);
            return stored?.requestedByKind === requestedByKind &&
                stored.requestedById === requestedById &&
                stored.idempotencyKey === observedKey
                ? stored
                : undefined;
        },
    };
    return {
        enqueues,
        idempotencyReads,
        repository,
        run: () => stored,
        setRun(run: JobRunRecord | undefined) {
            stored = run;
        },
    };
}

function request(
    actionId: ServiceActionId,
    overrides: Partial<ServiceActionQueueRequest> = {}
): ServiceActionQueueRequest {
    return {
        actionId,
        actor,
        authorizeDispatch: () => Promise.resolve(() => {}),
        idempotencyKey,
        requestId: "request-1",
        ...overrides,
    };
}

function queueFixture(
    fixture = repositoryFixture(),
    overrides: Partial<ServiceActionQueueDependencies> = {}
) {
    const ids = [
        "019fdf50-0000-7000-8000-000000000020",
        "019fdf50-0000-7000-8000-000000000021",
        "019fdf50-0000-7000-8000-000000000022",
        "019fdf50-0000-7000-8000-000000000023",
    ];
    return {
        fixture,
        queue: createServiceActionQueue({
            definitions,
            generateId: () => ids.shift()!,
            nowMs: () => 1000,
            repository: fixture.repository,
            ...overrides,
        }),
    };
}

describe("Service Action durable queue", () => {
    for (const actionId of serviceActionIds) {
        test(`queues exact empty payload and action mapping for ${actionId}`, async () => {
            const wakeCalls: string[] = [];
            let authorizationChecks = 0;
            const { fixture, queue } = queueFixture(repositoryFixture(), {
                wakeEventPump: () => {
                    wakeCalls.push(actionId);
                },
            });

            const result = await queue.enqueue(
                request(actionId, {
                    authorizeDispatch: () =>
                        Promise.resolve(() => {
                            authorizationChecks += 1;
                            expect(fixture.enqueues).toHaveLength(0);
                        }),
                })
            );

            expect(result).toEqual({
                actionId,
                jobRunId: "019fdf50-0000-7000-8000-000000000020",
                queued: true,
            });
            expect(authorizationChecks).toBe(1);
            expect(wakeCalls).toEqual([actionId]);
            expect(fixture.enqueues).toHaveLength(1);
            expect(fixture.enqueues[0]?.run).toMatchObject({
                actionKey: serviceActionJobActionKeys[actionId],
                attemptLimit: 1,
                cancellationPolicy: "never",
                idempotencyKey,
                payloadJson: "{}",
                requestedById: actor.id,
                requestedByKind: "user",
                resourceClass: "exclusive",
                retrySafe: false,
                triggerType: "manual",
            });
            expect(fixture.enqueues[0]?.auditEvents).toMatchObject([
                {
                    action: "service-actions.request.enqueue",
                    actorId: actor.id,
                    authenticatorId: actor.authenticatorId,
                    metadataJson: JSON.stringify({ actionId }),
                    outcome: "accepted",
                    requestId: "request-1",
                },
            ]);
        });
    }

    test("returns a matching replay without reauthorization or re-enqueue", async () => {
        const { fixture, queue } = queueFixture();
        const first = await queue.enqueue(request("system-update"));
        let authorizationChecks = 0;

        const replay = await queue.enqueue(
            request("system-update", {
                authorizeDispatch: () =>
                    Promise.resolve(() => {
                        authorizationChecks += 1;
                    }),
            })
        );

        expect(replay).toEqual(first);
        expect(authorizationChecks).toBe(0);
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("binds one idempotency key to the exact action and authenticator session", async () => {
        const { fixture, queue } = queueFixture();
        await queue.enqueue(request("system-update"));

        for (const conflicting of [
            request("system-restart"),
            request("system-update", {
                actor: {
                    ...actor,
                    authenticatorId: "019fdf50-0000-7000-8000-000000000099",
                },
            }),
        ]) {
            const failure = await queue
                .enqueue(conflicting)
                .catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(ServiceActionQueueError);
            expect(failure).toMatchObject({ reason: "conflict" });
        }
        expect(fixture.enqueues).toHaveLength(1);
    });

    test("reconciles a matching actor/action/payload run after enqueue throws", async () => {
        const fixture = repositoryFixture();
        const originalEnqueue = fixture.repository.enqueueManualRun;
        fixture.repository.enqueueManualRun = async (input) => {
            await originalEnqueue(input);
            throw new Error("private commit acknowledgement failure");
        };
        const wakes: string[] = [];
        const { queue } = queueFixture(fixture, {
            wakeEventPump: () => {
                wakes.push("wake");
            },
        });

        const result = await queue.enqueue(request("openclaw-cleanup"));

        expect(result).toEqual({
            actionId: "openclaw-cleanup",
            jobRunId: "019fdf50-0000-7000-8000-000000000020",
            queued: true,
        });
        expect(fixture.idempotencyReads).toHaveLength(2);
        expect(wakes).toEqual(["wake"]);
    });

    test("maps missing or failed enqueue readback to unknown outcome", async () => {
        for (const readback of ["missing", "throws"] as const) {
            const fixture = repositoryFixture();
            fixture.repository.enqueueManualRun = () =>
                Promise.reject(new Error("private enqueue failure"));
            if (readback === "throws") {
                let reads = 0;
                fixture.repository.findRunByIdempotency = () => {
                    reads += 1;
                    if (reads > 1) throw new Error("private read failure");
                };
            }
            const { queue } = queueFixture(fixture);

            const failure = await queue
                .enqueue(request("openclaw-update"))
                .catch((error: unknown) => error);

            expect(failure).toBeInstanceOf(ServiceActionQueueError);
            expect(failure).toMatchObject({ reason: "unknown-outcome" });
            expect(String(failure)).not.toContain("private");
        }
    });

    test("maps a mismatched enqueue readback to conflict", async () => {
        const fixture = repositoryFixture();
        const originalEnqueue = fixture.repository.enqueueManualRun;
        fixture.repository.enqueueManualRun = async (input) => {
            await originalEnqueue(input);
            const committed = fixture.run();
            if (committed === undefined) throw new Error("Expected committed run");
            fixture.setRun({ ...committed, payloadJson: '{"unexpected":true}' });
            throw new Error("private enqueue failure");
        };
        const { queue } = queueFixture(fixture);

        const failure = await queue
            .enqueue(request("system-restart"))
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ServiceActionQueueError);
        expect(failure).toMatchObject({ reason: "conflict" });
    });

    test("never calls the repository when dispatch authorization rejects", async () => {
        const { fixture, queue } = queueFixture();
        const authorizationFailure = new Error("authorization expired");

        const failure = await queue
            .enqueue(
                request("system-restart", {
                    authorizeDispatch: () => Promise.reject(authorizationFailure),
                })
            )
            .catch((error: unknown) => error);

        expect(failure).toBe(authorizationFailure);
        expect(fixture.enqueues).toEqual([]);
        expect(fixture.run()).toBeUndefined();
    });

    test("does not insert when the final admitted authorization fence rejects", async () => {
        const { fixture, queue } = queueFixture();
        const authorizationFailure = new Error("authorization changed during admission");

        const failure = await queue
            .enqueue(
                request("system-restart", {
                    authorizeDispatch: () =>
                        Promise.resolve(() => {
                            throw authorizationFailure;
                        }),
                })
            )
            .catch((error: unknown) => error);

        expect(failure).toBe(authorizationFailure);
        expect(fixture.enqueues).toEqual([]);
        expect(fixture.run()).toBeUndefined();
    });

    test("rejects unsafe injected action mappings at composition", () => {
        expect(() =>
            createServiceActionQueue({
                definitions: {
                    ...definitions,
                    "system-update": {
                        ...definitions["system-update"],
                        actionKey: "host.system.unreviewed",
                    },
                },
                repository: repositoryFixture().repository,
            })
        ).toThrow("Service Action definition is invalid");
    });
});
