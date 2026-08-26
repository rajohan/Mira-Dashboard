import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
    dockerOverviewCacheKey,
    dockerOverviewCacheSchemaId,
    dockerOverviewCacheSource,
    type DockerOverviewCachePayload,
    type DockerUpdaterEvent,
} from "../../../contracts/docker.ts";
import { DockerUpdaterSourceConflictError } from "../../../contracts/dockerWorker.ts";
import {
    type JobActionExecutionContext,
    type JobCacheAttemptCommit,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
} from "./actionRegistry.ts";
import {
    createDockerOperationJobExecutor,
    createDockerOverviewJobExecutor,
    createDockerUpdaterJobExecutor,
    type DockerJobExecutionPort,
    dockerUpdaterEventNotification,
    dockerUpdaterEventsNotification,
} from "./dockerActionExecutors.ts";

const sourceRevision = "a".repeat(64);
const serviceId = "b".repeat(64);
const previousEvent = Object.freeze({
    atMs: 1000,
    id: "018f6f50-6a9e-7000-8000-000000000001",
    kind: "update-available" as const,
    summary: "An existing update remains available",
});
const availableEvent = Object.freeze({
    atMs: 2000,
    id: "018f6f50-6a9e-7000-8000-000000000002",
    kind: "update-available" as const,
    serviceId,
    summary: "A new update is available",
});
const scanEvent = Object.freeze({
    atMs: 3000,
    id: "018f6f50-6a9e-7000-8000-000000000003",
    kind: "scan-completed" as const,
    summary: "Docker update scan completed",
});

function overview(
    updaterEvents: readonly DockerUpdaterEvent[] = []
): DockerOverviewCachePayload {
    return {
        containers: [],
        images: [],
        observedAtMs: 4000,
        sourceRevision,
        updaterEvents: [...updaterEvents],
        updaterServices: [],
        volumes: [],
    };
}

function executionPort(
    overrides: Partial<DockerJobExecutionPort> = {}
): DockerJobExecutionPort {
    return {
        execute: (payload) =>
            Promise.resolve({
                operation: payload.operation,
                outcome: "completed",
                targetCount: 1,
            }),
        readPrevious: () => null,
        refresh: () => Promise.resolve(overview()),
        runUpdater: () =>
            Promise.resolve({
                failedCount: 0,
                outcome: "completed",
                payload: overview(),
                updatedCount: 0,
            }),
        scan: () => Promise.resolve(overview()),
        ...overrides,
    };
}

function executionContext(
    attempts: JobCacheAttemptCommit[],
    outputs: string[] = [],
    order?: string[]
): JobActionExecutionContext {
    return {
        armHostRestartClaimFence: () => Promise.resolve(),
        clearHostRestartClaimFence: () => Promise.resolve(),
        commitCacheAttempt: (attempt) => {
            attempts.push(attempt);
            order?.push(`commit:${attempt.kind}`);
            return Promise.resolve("committed");
        },
        databaseReleaseId: "c".repeat(40),
        nowMs: () => 5000,
        reportProgress: () => Effect.succeed("appended"),
        workerInstanceId: "018f6f50-6a9e-7000-8000-000000000004",
        writeOutput: (_kind, message) => {
            outputs.push(message);
            return Effect.succeed("appended");
        },
    };
}

describe("Docker job action executors", () => {
    test("aggregates multiple available services into one run notification", () => {
        const second = {
            ...availableEvent,
            id: "018f6f50-6a9e-7000-8000-000000000009",
            serviceId: "c".repeat(64),
        };

        expect(dockerUpdaterEventsNotification([availableEvent, second])).toEqual({
            id: availableEvent.id,
            kind: "docker.updates-available",
            linkUrl: "/docker",
            message: "2 Docker services have updates available.",
            occurredAtMs: availableEvent.atMs,
            severity: "info",
            source: "docker-updater",
            title: "Docker updates available",
        });
    });
    test("persists claim-fenced overview success without replaying retained events", async () => {
        const previous = overview([previousEvent]);
        const next = overview([availableEvent, previousEvent]);
        const attempts: JobCacheAttemptCommit[] = [];
        const published: DockerUpdaterEvent[][] = [];
        const refreshInputs: unknown[] = [];
        const executor = createDockerOverviewJobExecutor(
            executionPort({
                publishEvents(events) {
                    published.push([...events]);
                    return Promise.resolve();
                },
                readPrevious: () => previous,
                refresh(input, signal) {
                    refreshInputs.push(input, signal);
                    return Promise.resolve(next);
                },
            })
        );

        expect(
            await Effect.runPromise(
                executor(executionContext(attempts), { key: dockerOverviewCacheKey })
            )
        ).toEqual({ cacheKeys: [dockerOverviewCacheKey], completedAtMs: 5000 });
        expect(refreshInputs).toEqual([previous, expect.any(AbortSignal)]);
        expect(attempts).toEqual([
            {
                durationMs: expect.any(Number),
                entries: [
                    {
                        key: dockerOverviewCacheKey,
                        metadata: { kind: "docker-overview" },
                        payload: next,
                        schemaId: dockerOverviewCacheSchemaId,
                        source: dockerOverviewCacheSource,
                        ttlMs: 300_000,
                    },
                ],
                kind: "succeeded",
            },
        ]);
        expect(published).toEqual([]);
    });

    test("retries only the first unconfirmed event from the current updater run", async () => {
        const previous = overview([previousEvent]);
        const next = overview([availableEvent, previousEvent, scanEvent]);
        const attempts: JobCacheAttemptCommit[] = [];
        const published: DockerUpdaterEvent[][] = [];
        const delivered = new Map<string, DockerUpdaterEvent>();
        let scanPublicationAttempt = 0;
        const port = executionPort({
            publishEvents(events) {
                published.push([...events]);
                const containsScan = events.some(({ id }) => id === scanEvent.id);
                if (containsScan) {
                    scanPublicationAttempt += 1;
                }
                if (containsScan && scanPublicationAttempt === 1) {
                    delivered.delete(availableEvent.id);
                    return Promise.reject(
                        new Error("transient notification write failure")
                    );
                }
                for (const event of events) delivered.set(event.id, event);
                return Promise.resolve();
            },
            readPrevious: () => previous,
            runUpdater: () =>
                Promise.resolve({
                    failedCount: 0,
                    outcome: "completed",
                    payload: next,
                    updatedCount: 1,
                }),
        });
        const executor = createDockerUpdaterJobExecutor(port);

        expect(
            await Effect.runPromise(
                executor(executionContext(attempts), { kind: "updater-run" })
            )
        ).toEqual({
            completedAtMs: 5000,
            failedCount: 0,
            outcome: "completed",
            updatedCount: 1,
        });
        expect(published).toEqual([
            [availableEvent, scanEvent],
            [availableEvent, scanEvent],
        ]);
        expect([...delivered.values()]).toEqual([availableEvent, scanEvent]);
        expect(attempts.map(({ kind }) => kind)).toEqual(["succeeded"]);
    });

    test("persists sanitized overview failure and classifies it as retryable", async () => {
        const privateDiagnostic =
            "docker inspect exposed SECRET=value and /opt/docker/private/compose.yaml";
        const attempts: JobCacheAttemptCommit[] = [];
        const outputs: string[] = [];
        const failure = await Effect.runPromise(
            createDockerOverviewJobExecutor(
                executionPort({
                    refresh: () => Promise.reject(new Error(privateDiagnostic)),
                })
            )(executionContext(attempts, outputs), { key: dockerOverviewCacheKey })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(failure).toHaveProperty(
            "message",
            "The job action reported a retryable failure"
        );
        expect(attempts).toEqual([
            {
                durationMs: expect.any(Number),
                failureCode: "provider/docker-overview-unavailable",
                failureMessage: "Docker overview projection could not be collected.",
                key: dockerOverviewCacheKey,
                kind: "failed",
            },
        ]);
        expect(JSON.stringify({ attempts, outputs })).not.toContain(privateDiagnostic);
    });

    test("publishes one sanitized discovery failure per failure transition", async () => {
        const privateDiagnostic =
            "docker inspect exposed SECRET=value and /opt/docker/private/compose.yaml";
        const attempts: JobCacheAttemptCommit[] = [];
        const published: DockerUpdaterEvent[][] = [];
        let attemptStatus: "failed" | "succeeded" | undefined;
        let discoveryFails = true;
        const port = executionPort({
            publishEvents(events) {
                published.push([...events]);
                return Promise.resolve();
            },
            readPreviousAttemptStatus: () => attemptStatus,
            refresh: () =>
                discoveryFails
                    ? Promise.reject(new Error(privateDiagnostic))
                    : Promise.resolve(overview()),
        });
        const baseContext = executionContext(attempts);
        const context: JobActionExecutionContext = {
            ...baseContext,
            commitCacheAttempt(attempt) {
                attempts.push(attempt);
                attemptStatus = attempt.kind;
                return Promise.resolve("committed");
            },
        };
        const executor = createDockerOverviewJobExecutor(port);
        const run = () =>
            Effect.runPromise(executor(context, { key: dockerOverviewCacheKey }));

        expect(await run().catch((error: unknown) => error)).toBeInstanceOf(
            JobActionRetryableError
        );
        expect(await run().catch((error: unknown) => error)).toBeInstanceOf(
            JobActionRetryableError
        );
        expect(published).toHaveLength(1);

        discoveryFails = false;
        expect(await run()).toEqual({
            cacheKeys: [dockerOverviewCacheKey],
            completedAtMs: 5000,
        });
        discoveryFails = true;
        expect(await run().catch((error: unknown) => error)).toBeInstanceOf(
            JobActionRetryableError
        );

        expect(attempts.map(({ kind }) => kind)).toEqual([
            "failed",
            "failed",
            "succeeded",
            "failed",
        ]);
        expect(published).toHaveLength(2);
        expect(published[0]).toEqual([
            {
                atMs: 5000,
                id: expect.stringMatching(
                    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
                ),
                kind: "discovery-failed",
                summary:
                    "Docker discovery failed. The last successful overview remains available when retained.",
            },
        ]);
        expect(published[1]?.[0]?.id).not.toBe(published[0]?.[0]?.id);
        expect(dockerUpdaterEventNotification(published[0]![0]!)).toEqual({
            id: published[0]![0]!.id,
            kind: "docker.discovery-failed",
            linkUrl: "/docker",
            message:
                "Docker discovery failed. The last successful overview remains available when retained.",
            occurredAtMs: 5000,
            severity: "warning",
            source: "docker-updater",
            title: "Docker discovery failed",
        });
        expect(JSON.stringify({ attempts, published })).not.toContain(privateDiagnostic);
    });

    test("does not publish a discovery failure after the cache claim is lost", async () => {
        const published: DockerUpdaterEvent[][] = [];
        const privateDiagnostic = "docker inspect exposed SECRET=value";
        const port = executionPort({
            publishEvents(events) {
                published.push([...events]);
                return Promise.resolve();
            },
            readPreviousAttemptStatus: () => "succeeded",
            refresh: () => Promise.reject(new Error(privateDiagnostic)),
        });
        const context: JobActionExecutionContext = {
            ...executionContext([]),
            commitCacheAttempt: () => Promise.reject(new Error("claim lost")),
        };

        const failure = await Effect.runPromise(
            createDockerOverviewJobExecutor(port)(context, {
                key: dockerOverviewCacheKey,
            })
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(published).toEqual([]);
        expect(JSON.stringify(published)).not.toContain(privateDiagnostic);
    });

    test("publishes only current scan transitions and suppresses raw diagnostics", async () => {
        const previous = overview([previousEvent]);
        const next = overview([scanEvent, availableEvent, previousEvent]);
        const attempts: JobCacheAttemptCommit[] = [];
        const outputs: string[] = [];
        const published: DockerUpdaterEvent[][] = [];
        const privateDiagnostic = "registry response contained SECRET=value";
        const executor = createDockerUpdaterJobExecutor(
            executionPort({
                publishEvents(events) {
                    published.push([...events]);
                    if (
                        events.every(
                            (event) => dockerUpdaterEventNotification(event) === undefined
                        )
                    ) {
                        return Promise.resolve();
                    }
                    return Promise.reject(new Error(privateDiagnostic));
                },
                readPrevious: () => previous,
                scan(input, signal) {
                    expect(input).toEqual(previous);
                    expect(signal).toBeInstanceOf(AbortSignal);
                    return Promise.resolve(next);
                },
            })
        );

        expect(
            await Effect.runPromise(
                executor(executionContext(attempts, outputs), {
                    operation: "updater-scan",
                    sourceRevision,
                })
            )
        ).toEqual({
            completedAtMs: 5000,
            failedCount: 0,
            outcome: "completed",
            postSettlementWarnings: ["docker-notification-publication-failed"],
            updatedCount: 0,
        });
        expect(published).toEqual([
            [scanEvent, availableEvent],
            [scanEvent, availableEvent],
        ]);
        expect(outputs).toEqual([
            "Docker notification publication failed after bounded retries; the durable Docker job result remains authoritative.",
        ]);
        expect(JSON.stringify({ attempts, outputs })).not.toContain(privateDiagnostic);
    });

    test("fails a stale manual scan without degrading the overview cache", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const published: DockerUpdaterEvent[][] = [];
        const executor = createDockerUpdaterJobExecutor(
            executionPort({
                publishEvents(events) {
                    published.push([...events]);
                    return Promise.resolve();
                },
                scan: () =>
                    Promise.resolve({
                        ...overview([scanEvent]),
                        sourceRevision: "f".repeat(64),
                    }),
            })
        );

        const failure = await Effect.runPromise(
            executor(executionContext(attempts), {
                operation: "updater-scan",
                sourceRevision,
            })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(attempts).toEqual([]);
        expect(published).toEqual([]);
    });

    test("does not degrade the overview cache for typed late source drift", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const executor = createDockerUpdaterJobExecutor(
            executionPort({
                runUpdater: () => Promise.reject(new DockerUpdaterSourceConflictError()),
            })
        );

        const failure = await Effect.runPromise(
            executor(executionContext(attempts), {
                operation: "updater-run",
                sourceRevision,
            })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(failure).toMatchObject({
            cause: expect.any(DockerUpdaterSourceConflictError),
        });
        expect(attempts).toEqual([]);
    });

    test("still records a cache failure for a non-conflict updater failure", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const executor = createDockerUpdaterJobExecutor(
            executionPort({
                runUpdater: () => Promise.reject(new Error("private provider failure")),
            })
        );

        const failure = await Effect.runPromise(
            executor(executionContext(attempts), { kind: "updater-run" })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(attempts).toEqual([
            expect.objectContaining({
                failureCode: "provider/docker-overview-unavailable",
                kind: "failed",
            }),
        ]);
        expect(JSON.stringify(attempts)).not.toContain("private provider failure");
    });

    test("routes scheduled and manual updater payloads with exact source fences", async () => {
        const previous = overview();
        const cases = [
            {
                expected: { previous },
                payload: { kind: "updater-run" },
            },
            {
                expected: { expectedSourceRevision: sourceRevision, previous },
                payload: { operation: "updater-run", sourceRevision },
            },
            {
                expected: {
                    candidateImage: "ghcr.io/example/app:1.1.0",
                    currentImage: "ghcr.io/example/app:1.0.0",
                    expectedSourceRevision: sourceRevision,
                    previous,
                    serviceId,
                },
                payload: {
                    candidateImage: "ghcr.io/example/app:1.1.0",
                    currentImage: "ghcr.io/example/app:1.0.0",
                    operation: "updater-update-service",
                    serviceId,
                    sourceRevision,
                },
            },
        ] as const;

        for (const testCase of cases) {
            const inputs: unknown[] = [];
            const attempts: JobCacheAttemptCommit[] = [];
            const executor = createDockerUpdaterJobExecutor(
                executionPort({
                    readPrevious: () => previous,
                    runUpdater(input, signal) {
                        inputs.push(input, signal);
                        return Promise.resolve({
                            failedCount: 0,
                            outcome: "completed",
                            payload: overview(),
                            updatedCount: 0,
                        });
                    },
                })
            );

            await Effect.runPromise(
                executor(executionContext(attempts), testCase.payload)
            );
            expect(inputs).toEqual([testCase.expected, expect.any(AbortSignal)]);
            expect(attempts).toHaveLength(1);
            expect(attempts[0]?.kind).toBe("succeeded");
        }
    });

    test("returns source-sync-pending after committing its authoritative snapshot", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const next = overview();
        const result = await Effect.runPromise(
            createDockerUpdaterJobExecutor(
                executionPort({
                    runUpdater: () =>
                        Promise.resolve({
                            failedCount: 0,
                            outcome: "source-sync-pending",
                            payload: next,
                            updatedCount: 1,
                        }),
                })
            )(executionContext(attempts), { kind: "updater-run" })
        );

        expect(result).toEqual({
            completedAtMs: 5000,
            failedCount: 0,
            outcome: "source-sync-pending",
            updatedCount: 1,
        });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]).toMatchObject({ kind: "succeeded" });
    });

    test("preserves updater settlement and suppresses publication without a cache commit", async () => {
        const privateDiagnostic = "SECRET=value /opt/docker/private/compose.yaml";
        const attempts: JobCacheAttemptCommit[] = [];
        const outputs: string[] = [];
        const published: DockerUpdaterEvent[][] = [];
        const baseContext = executionContext(attempts, outputs);
        const context: JobActionExecutionContext = {
            ...baseContext,
            commitCacheAttempt(attempt) {
                attempts.push(attempt);
                return Promise.reject(new Error(privateDiagnostic));
            },
        };

        const result = await Effect.runPromise(
            createDockerUpdaterJobExecutor(
                executionPort({
                    publishEvents(events) {
                        published.push([...events]);
                        return Promise.reject(new Error(privateDiagnostic));
                    },
                    runUpdater: () =>
                        Promise.resolve({
                            failedCount: 1,
                            outcome: "completed-with-failures",
                            payload: overview([availableEvent]),
                            updatedCount: 2,
                        }),
                })
            )(context, { kind: "updater-run" })
        );

        expect(result).toEqual({
            completedAtMs: 5000,
            failedCount: 1,
            outcome: "completed-with-failures",
            postSettlementWarnings: ["docker-overview-cache-commit-failed"],
            updatedCount: 2,
        });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.kind).toBe("succeeded");
        expect(published).toEqual([]);
        expect(outputs).toEqual([
            "The Docker action settled, but its refreshed overview could not be committed; the durable job result remains authoritative.",
        ]);
        expect(JSON.stringify({ attempts, outputs, result })).not.toContain(
            privateDiagnostic
        );
    });

    test("classifies an unknown updater outcome only after committing the refresh", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const order: string[] = [];
        const failure = await Effect.runPromise(
            createDockerUpdaterJobExecutor(
                executionPort({
                    runUpdater: () => {
                        order.push("update");
                        return Promise.resolve({
                            failedCount: 1,
                            outcome: "unknown-outcome",
                            payload: overview(),
                            updatedCount: 0,
                        });
                    },
                })
            )(executionContext(attempts, [], order), {
                operation: "updater-run",
                sourceRevision,
            })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionOutcomeUnknownError);
        expect(order).toEqual(["update", "commit:succeeded"]);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.kind).toBe("succeeded");
    });

    test("preserves unknown updater settlement when cache follow-up fails", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const outputs: string[] = [];
        const baseContext = executionContext(attempts, outputs);
        const context: JobActionExecutionContext = {
            ...baseContext,
            commitCacheAttempt(attempt) {
                attempts.push(attempt);
                return Promise.reject(new Error("private cache diagnostic"));
            },
        };

        const failure = await Effect.runPromise(
            createDockerUpdaterJobExecutor(
                executionPort({
                    runUpdater: () =>
                        Promise.resolve({
                            failedCount: 1,
                            outcome: "unknown-outcome",
                            payload: overview(),
                            updatedCount: 0,
                        }),
                })
            )(context, { kind: "updater-run" })
        ).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(JobActionOutcomeUnknownError);
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.kind).toBe("succeeded");
        expect(outputs).toEqual([
            "The Docker action settled, but its refreshed overview could not be committed; the durable job result remains authoritative.",
        ]);
        expect(JSON.stringify({ attempts, outputs })).not.toContain(
            "private cache diagnostic"
        );
    });

    test("refreshes fixed operations and preserves unknown-outcome classification", async () => {
        const previous = overview();
        const next = overview();
        const attempts: JobCacheAttemptCommit[] = [];
        const order: string[] = [];
        const payload = { operation: "stack-restart" as const, sourceRevision };
        const result = await Effect.runPromise(
            createDockerOperationJobExecutor(
                executionPort({
                    execute(input, signal) {
                        order.push("execute");
                        expect(input).toEqual(payload);
                        expect(signal).toBeInstanceOf(AbortSignal);
                        return Promise.resolve({
                            operation: "stack-restart",
                            outcome: "completed",
                            targetCount: 4,
                        });
                    },
                    readPrevious: () => previous,
                    refresh(input, signal) {
                        order.push("refresh");
                        expect(input).toEqual(previous);
                        expect(signal).toBeInstanceOf(AbortSignal);
                        return Promise.resolve(next);
                    },
                })
            )(executionContext(attempts, [], order), payload)
        );

        expect(result).toEqual({
            completedAtMs: 5000,
            operation: "stack-restart",
            status: "completed",
            targetCount: 4,
        });
        expect(order).toEqual(["execute", "refresh", "commit:succeeded"]);
        expect(attempts).toHaveLength(1);

        let refreshedAfterUnknownOutcome = false;
        const unknownAttempts: JobCacheAttemptCommit[] = [];
        const unknown = await Effect.runPromise(
            createDockerOperationJobExecutor(
                executionPort({
                    execute: () =>
                        Promise.resolve({
                            operation: "stack-restart",
                            outcome: "unknown-outcome",
                            targetCount: 0,
                        }),
                    refresh: () => {
                        refreshedAfterUnknownOutcome = true;
                        return Promise.resolve(next);
                    },
                })
            )(executionContext(unknownAttempts), payload)
        ).catch((error: unknown) => error);
        expect(unknown).toBeInstanceOf(JobActionOutcomeUnknownError);
        expect(refreshedAfterUnknownOutcome).toBeFalse();
        expect(unknownAttempts).toEqual([]);
    });

    test("preserves fixed operation settlement when cache and notification follow-up fail", async () => {
        const privateDiagnostic = "SECRET=value /opt/docker/private/compose.yaml";
        const attempts: JobCacheAttemptCommit[] = [];
        const outputs: string[] = [];
        const published: DockerUpdaterEvent[][] = [];
        const payload = { operation: "stack-restart" as const, sourceRevision };
        const baseContext = executionContext(attempts, outputs);
        const context: JobActionExecutionContext = {
            ...baseContext,
            commitCacheAttempt(attempt) {
                attempts.push(attempt);
                return Promise.reject(new Error(privateDiagnostic));
            },
        };

        const result = await Effect.runPromise(
            createDockerOperationJobExecutor(
                executionPort({
                    execute: () =>
                        Promise.resolve({
                            operation: "stack-restart",
                            outcome: "completed",
                            targetCount: 4,
                        }),
                    publishEvents(events) {
                        published.push([...events]);
                        return Promise.reject(new Error(privateDiagnostic));
                    },
                    refresh: () => Promise.resolve(overview([availableEvent])),
                })
            )(context, payload)
        );

        expect(result).toEqual({
            completedAtMs: 5000,
            operation: "stack-restart",
            postSettlementWarnings: ["docker-overview-cache-commit-failed"],
            status: "completed",
            targetCount: 4,
        });
        expect(attempts).toHaveLength(1);
        expect(attempts[0]?.kind).toBe("succeeded");
        expect(published).toEqual([]);
        expect(outputs).toEqual([
            "The Docker action settled, but its refreshed overview could not be committed; the durable job result remains authoritative.",
        ]);
        expect(JSON.stringify({ attempts, outputs, result })).not.toContain(
            privateDiagnostic
        );
    });
});
