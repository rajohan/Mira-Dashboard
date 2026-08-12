import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { databaseObservabilityMetricDatabases } from "../../../shared/databaseObservabilityPolicy.ts";
import { OpenClawServiceActionsExecutionError } from "../../../shared/openClawServiceActions.ts";
import {
    testMoltbookCollector,
    testMoltbookDashboardSnapshot,
} from "../../test/support/moltbook.ts";
import {
    createJobWorkerActionResolver,
    createDatabaseObservabilityExecutor,
    createHostOperationJobExecutor,
    createLogMaintenanceJobExecutor,
    createMoltbookDashboardExecutor,
    createOpenClawGatewayRestartJobExecutor,
    createOpenClawServiceActionJobExecutor,
    createSqliteMaintenanceJobExecutor,
    createSystemHostExecutor,
    createWorkspaceFileWriteJobExecutor,
    createJobWorkerActionRegistry,
    type WorkspaceFileWriteExecutionPort,
} from "./actionExecutors.ts";
import {
    type JobActionExecutionContext,
    type JobCacheAttemptCommit,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
    hostSystemRestartJobActionDefinition,
    jobActionDefinitions,
} from "./actionRegistry.ts";

function executionContext(attempts: JobCacheAttemptCommit[]): JobActionExecutionContext {
    return {
        armHostRestartClaimFence: () => Promise.resolve(),
        clearHostRestartClaimFence: () => Promise.resolve(),
        commitCacheAttempt: (attempt) => {
            attempts.push(attempt);
            return Promise.resolve("committed");
        },
        databaseReleaseId: "a".repeat(40),
        nowMs: () => 5000,
        reportProgress: () => Effect.succeed("appended"),
        workerInstanceId: "019fdf50-0000-7000-8000-000000000001",
        writeOutput: () => Effect.succeed("appended"),
    };
}

const successfulExecutor = () => Effect.succeed({});

describe("worker-only job executor registry", () => {
    test("persists only the validated path-free SQLite maintenance result", () => {
        const signalSeen: AbortSignal[] = [];
        const executor = createSqliteMaintenanceJobExecutor({
            run(signal) {
                if (signal !== undefined) signalSeen.push(signal);
                return Promise.resolve({
                    backupBytes: 4096,
                    backupCreatedAtMs: 4000,
                    checkpoint: {
                        busyFrames: 0,
                        checkpointedFrames: 2,
                        logFrames: 2,
                    },
                    completedAtMs: 5000,
                    retainedBackupBytes: 4096,
                    retainedBackupCount: 1,
                    status: "completed",
                });
            },
        });
        expect(
            Effect.runPromise(executor(executionContext([]), {}))
        ).resolves.toMatchObject({ backupBytes: 4096, status: "completed" });
        expect(signalSeen).toEqual([expect.any(AbortSignal)]);
        expect(
            Effect.runPromise(executor(executionContext([]), { path: "/private" }))
        ).rejects.toThrow("SQLite maintenance action failed");
    });

    test("matches every pure definition with one exact executor", () => {
        const findAction = createJobWorkerActionResolver({
            logMaintenance: { run: () => Promise.resolve(undefined) },
            moltbook: testMoltbookCollector,
            openClawGateway: { restart: () => Promise.resolve() },
            openClawServiceActions: {
                cleanupSessions: () =>
                    Promise.resolve({
                        artifactsRemoved: 0,
                        bytesFreed: 0,
                        diskEntriesRemoved: 0,
                        diskFilesRemoved: 0,
                        dmScopesRetired: 0,
                        entriesAfter: 0,
                        entriesBefore: 0,
                        entriesCapped: 0,
                        entriesPruned: 0,
                        missingEntriesRemoved: 0,
                        modelRunsPruned: 0,
                        status: "completed",
                        storesProcessed: 0,
                    }),
                updateInstallation: () => Promise.resolve({ status: "accepted" }),
            },
        });
        expect(findAction("system.worker-smoke")).toBeDefined();
        expect(findAction("cache.refresh.system-host")).toBeDefined();
        expect(findAction("maintenance.rotate-logs")).toBeDefined();
        expect(findAction("openclaw.gateway.restart")).toMatchObject({
            cancellationPolicy: "never",
            resourceClass: "exclusive",
            retrySafe: false,
        });
        expect(findAction("openclaw.sessions.cleanup")).toBeDefined();
        expect(findAction("openclaw.installation.update")).toBeDefined();
        expect(findAction("host.system.cleanup")).toBeUndefined();
        expect(findAction("host.system.restart")).toBeUndefined();
        expect(findAction("host.system.update")).toBeUndefined();
        expect(findAction("system.shell")).toBeUndefined();
    });

    test("persists only a fixed restart result and forwards the action signal", async () => {
        const signals: Array<AbortSignal | undefined> = [];
        const executor = createOpenClawGatewayRestartJobExecutor({
            restart(signal) {
                signals.push(signal);
                return Promise.resolve();
            },
        });

        expect(await Effect.runPromise(executor(executionContext([]), {}))).toEqual({
            completedAtMs: 5000,
            status: "restarted",
        });
        expect(signals).toEqual([expect.any(AbortSignal)]);
        const failure = await Effect.runPromise(
            executor(executionContext([]), { command: "shell" })
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
    });

    test("persists only fixed host-operation settlement and rejects mismatched results", async () => {
        const calls: unknown[] = [];
        const fenceEvents: string[] = [];
        const restartContext: JobActionExecutionContext = {
            ...executionContext([]),
            armHostRestartClaimFence: () => {
                fenceEvents.push("arm");
                return Promise.resolve();
            },
            clearHostRestartClaimFence: () => {
                fenceEvents.push("clear");
                return Promise.resolve();
            },
        };
        const hostOperations = {
            availableOperations: () => Promise.resolve([]),
            request(
                operationId: "system-cleanup" | "system-restart" | "system-update",
                signal?: AbortSignal
            ) {
                calls.push({ operationId, signal });
                return Promise.resolve(
                    operationId === "system-restart"
                        ? ({ status: "accepted" } as const)
                        : ({ status: "completed" } as const)
                );
            },
        };
        expect(
            await Effect.runPromise(
                createHostOperationJobExecutor(hostOperations, "system-restart")(
                    restartContext,
                    {}
                )
            )
        ).toEqual({ completedAtMs: 5000, status: "accepted" });
        expect(fenceEvents).toEqual(["arm"]);
        expect(
            await Effect.runPromise(
                createHostOperationJobExecutor(hostOperations, "system-cleanup")(
                    executionContext([]),
                    {}
                )
            )
        ).toEqual({ completedAtMs: 5000, status: "completed" });
        expect(
            await Effect.runPromise(
                createHostOperationJobExecutor(hostOperations, "system-update")(
                    executionContext([]),
                    {}
                )
            )
        ).toEqual({ completedAtMs: 5000, status: "completed" });
        expect(calls).toMatchObject([
            { operationId: "system-restart", signal: expect.any(AbortSignal) },
            { operationId: "system-cleanup", signal: expect.any(AbortSignal) },
            { operationId: "system-update", signal: expect.any(AbortSignal) },
        ]);

        const failure = await Effect.runPromise(
            createHostOperationJobExecutor(
                {
                    availableOperations: () => Promise.resolve([]),
                    request: () => Promise.resolve({ status: "completed" }),
                },
                "system-restart"
            )(restartContext, {})
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(fenceEvents).toEqual(["arm", "arm"]);

        let restartDispatchAccepted = false;
        const brokerFailure = await Effect.runPromise(
            createHostOperationJobExecutor(
                {
                    availableOperations: () => Promise.resolve([]),
                    request: () => {
                        restartDispatchAccepted = true;
                        return Promise.reject(
                            new Error("response lost after systemctl accepted dispatch")
                        );
                    },
                },
                "system-restart"
            )(restartContext, {})
        ).catch((error: unknown) => error);
        expect(brokerFailure).toBeInstanceOf(Error);
        expect((brokerFailure as Error).message).toBe("Fixed host operation failed");
        expect((brokerFailure as Error).message).not.toContain("systemctl");
        expect(restartDispatchAccepted).toBeTrue();
        expect(fenceEvents).toEqual(["arm", "arm", "arm"]);
        expect(hostSystemRestartJobActionDefinition).toMatchObject({
            attemptLimit: 1,
            retrySafe: false,
        });

        const cleanupFailure = await Effect.runPromise(
            createHostOperationJobExecutor(
                {
                    availableOperations: () => Promise.resolve([]),
                    request: () => Promise.resolve({ status: "accepted" }),
                },
                "system-cleanup"
            )(executionContext([]), {})
        ).catch((error: unknown) => error);
        expect(cleanupFailure).toBeInstanceOf(Error);
    });

    test("persists only aggregate OpenClaw cleanup and validated update summaries", async () => {
        const signals: AbortSignal[] = [];
        const serviceActions = {
            cleanupSessions(signal?: AbortSignal) {
                if (signal !== undefined) signals.push(signal);
                return Promise.resolve({
                    artifactsRemoved: 2,
                    bytesFreed: 1024,
                    diskEntriesRemoved: 1,
                    diskFilesRemoved: 1,
                    dmScopesRetired: 3,
                    entriesAfter: 4,
                    entriesBefore: 8,
                    entriesCapped: 0,
                    entriesPruned: 2,
                    missingEntriesRemoved: 1,
                    modelRunsPruned: 1,
                    status: "completed" as const,
                    storesProcessed: 2,
                });
            },
            updateInstallation(signal?: AbortSignal) {
                if (signal !== undefined) signals.push(signal);
                return Promise.resolve({
                    afterVersion: "2026.8.0",
                    beforeVersion: "2026.7.2-beta.7",
                    status: "completed" as const,
                });
            },
        };
        expect(
            await Effect.runPromise(
                createOpenClawServiceActionJobExecutor(
                    serviceActions,
                    "openclaw-cleanup"
                )(executionContext([]), {})
            )
        ).toEqual({
            artifactsRemoved: 2,
            bytesFreed: 1024,
            completedAtMs: 5000,
            diskEntriesRemoved: 1,
            diskFilesRemoved: 1,
            dmScopesRetired: 3,
            entriesAfter: 4,
            entriesBefore: 8,
            entriesCapped: 0,
            entriesPruned: 2,
            missingEntriesRemoved: 1,
            modelRunsPruned: 1,
            status: "completed",
            storesProcessed: 2,
        });
        expect(
            await Effect.runPromise(
                createOpenClawServiceActionJobExecutor(serviceActions, "openclaw-update")(
                    executionContext([]),
                    {}
                )
            )
        ).toEqual({
            afterVersion: "2026.8.0",
            beforeVersion: "2026.7.2-beta.7",
            completedAtMs: 5000,
            status: "completed",
        });
        expect(signals).toEqual([expect.any(AbortSignal), expect.any(AbortSignal)]);

        const failure = await Effect.runPromise(
            createOpenClawServiceActionJobExecutor(
                {
                    cleanupSessions: (signal) => serviceActions.cleanupSessions(signal),
                    updateInstallation: () =>
                        Promise.resolve({
                            afterVersion: "../../private",
                            status: "completed",
                        }),
                },
                "openclaw-update"
            )(executionContext([]), {})
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).not.toContain("../../private");
        expect((failure as Error).message).not.toContain("private");

        const unknownFailure = await Effect.runPromise(
            createOpenClawServiceActionJobExecutor(
                {
                    cleanupSessions: () =>
                        Promise.reject(
                            new OpenClawServiceActionsExecutionError("unknown-outcome")
                        ),
                    updateInstallation: () => Promise.resolve({ status: "accepted" }),
                },
                "openclaw-cleanup"
            )(executionContext([]), {})
        ).catch((error: unknown) => error);
        expect(unknownFailure).toBeInstanceOf(JobActionOutcomeUnknownError);
        expect(String(unknownFailure)).not.toContain("Gateway");
        expect((unknownFailure as Error).message).not.toContain("Gateway");
    });

    test("fails closed for missing, extra, and duplicate executor keys", () => {
        expect(() =>
            createJobWorkerActionRegistry(jobActionDefinitions, [
                { actionKey: "maintenance.rotate-logs", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
            ])
        ).toThrow("do not exactly match");
        expect(() =>
            createJobWorkerActionRegistry(jobActionDefinitions, [
                { actionKey: "cache.refresh.system-host", execute: successfulExecutor },
                { actionKey: "maintenance.rotate-logs", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
                { actionKey: "system.extra", execute: successfulExecutor },
            ])
        ).toThrow("do not exactly match");
        expect(() =>
            createJobWorkerActionRegistry(jobActionDefinitions, [
                { actionKey: "cache.refresh.system-host", execute: successfulExecutor },
                { actionKey: "maintenance.rotate-logs", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
            ])
        ).toThrow("do not exactly match");
    });

    test("validates a fixed log policy and propagates Effect cancellation", async () => {
        const calls: Array<{
            dryRun: boolean;
            policyId: string;
            signal: AbortSignal | undefined;
        }> = [];
        const executor = createLogMaintenanceJobExecutor({
            run(policyId, dryRun, signal) {
                calls.push({ dryRun, policyId, signal });
                return Promise.resolve(
                    policyId === "docker-managed"
                        ? {
                              actionCounts: {
                                  compressed: 0,
                                  deleted: 0,
                                  error: 0,
                                  missing: 0,
                                  rotated: 1,
                                  skipped: 0,
                              },
                              checkedTargets: 1,
                              dryRun,
                              finishedAtMs: 4900,
                              ok: true,
                              startedAtMs: 4800,
                          }
                        : undefined
                );
            },
        });
        expect(
            await Effect.runPromise(
                executor(executionContext([]), { policyId: "docker-managed" })
            )
        ).toEqual({
            completedAtMs: 5000,
            dryRun: false,
            policyId: "docker-managed",
            status: "completed",
            summary: expect.objectContaining({ dryRun: false }),
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
            dryRun: false,
            policyId: "docker-managed",
        });
        expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);

        expect(
            await Effect.runPromise(
                executor(executionContext([]), {
                    dryRun: true,
                    policyId: "docker-managed",
                })
            )
        ).toMatchObject({
            dryRun: true,
            summary: { actionCounts: { rotated: 1 }, dryRun: true },
        });

        expect(
            Effect.runPromise(
                executor(executionContext([]), {
                    policyId: "/etc/logrotate.d/rsyslog",
                })
            )
        ).rejects.toBeInstanceOf(Error);
        expect(
            Effect.runPromise(
                executor(executionContext([]), {
                    dryRun: true,
                    policyId: "host-rsyslog",
                })
            )
        ).rejects.toBeInstanceOf(Error);
        expect(calls).toHaveLength(2);

        expect(
            Effect.runPromise(
                createLogMaintenanceJobExecutor({
                    run: () => Promise.resolve(undefined),
                })(executionContext([]), { policyId: "docker-managed" })
            )
        ).rejects.toBeInstanceOf(Error);
        expect(
            Effect.runPromise(
                createLogMaintenanceJobExecutor({
                    run: () =>
                        Promise.resolve({
                            actionCounts: {
                                compressed: 0,
                                deleted: 0,
                                error: 0,
                                missing: 0,
                                rotated: 1,
                                skipped: 0,
                            },
                            checkedTargets: 1,
                            dryRun: false,
                            finishedAtMs: 4900,
                            ok: true,
                            startedAtMs: 4800,
                        }),
                })(executionContext([]), { policyId: "host-rsyslog" })
            )
        ).rejects.toBeInstanceOf(Error);
    });

    test("keeps the dynamic workspace write executor worker-only and path-free", async () => {
        const calls: unknown[] = [];
        const settledCommands: unknown[] = [];
        const writer: WorkspaceFileWriteExecutionPort = {
            apply(command, signal) {
                calls.push({ command, signal });
                return Promise.resolve({
                    modifiedAtMs: 4000,
                    revision: "b".repeat(64),
                    sizeBytes: 12,
                });
            },
            removeSettledReplacementIntent(command) {
                settledCommands.push(command);
                return Promise.resolve();
            },
        };
        const executor = createWorkspaceFileWriteJobExecutor(writer);
        const payload = {
            actorBindingSha256: "a".repeat(64),
            command: {
                fileName: "notes.txt",
                locator: { rootId: "workspace", segments: [] },
                mimeType: "text/plain",
                operation: "create",
                sha256: "c".repeat(64),
                sizeBytes: 12,
                spoolId: "019fdf50-0000-4000-8000-000000000001",
                ticketId: "019fdf50-0000-4000-8000-000000000002",
            },
        } as const;

        expect(await Effect.runPromise(executor(executionContext([]), payload))).toEqual({
            modifiedAtMs: 4000,
            revision: "b".repeat(64),
            sizeBytes: 12,
            status: "completed",
            ticketId: payload.command.ticketId,
        });
        expect(calls).toMatchObject([
            {
                command: payload.command,
                signal: expect.any(AbortSignal),
            },
        ]);

        const findAction = createJobWorkerActionResolver({
            logMaintenance: { run: () => Promise.resolve(undefined) },
            moltbook: testMoltbookCollector,
            workspaceFiles: writer,
        });
        expect(findAction("workspace-files.apply-write")).toBeDefined();
        expect(findAction("workspace-files.apply-write")).not.toHaveProperty(
            "scheduleId"
        );
        expect(findAction("workspace-files.apply-write")).not.toHaveProperty(
            "afterSuccessfulSettlement"
        );
        expect(findAction("workspace-files.apply-replacement")).toMatchObject({
            attemptLimit: 3,
            retrySafe: true,
        });

        const replacementPayload = {
            ...payload,
            command: {
                ...payload.command,
                expectedRevision: "d".repeat(64),
                locator: {
                    rootId: "workspace",
                    segments: [payload.command.fileName],
                },
                operation: "replace" as const,
            },
        };
        await findAction(
            "workspace-files.apply-replacement"
        )?.afterSuccessfulSettlement?.(replacementPayload);
        expect(settledCommands).toEqual([replacementPayload.command]);

        const failedExecutor = createWorkspaceFileWriteJobExecutor({
            apply: () => Promise.reject(new Error("private write failure")),
            removeSettledReplacementIntent: () => Promise.resolve(),
        });
        const createFailure = await Effect.runPromise(
            failedExecutor(executionContext([]), payload)
        ).catch((error: unknown) => error);
        expect(createFailure).toBeInstanceOf(Error);
        expect(createFailure).not.toBeInstanceOf(JobActionRetryableError);

        const replaceFailure = await Effect.runPromise(
            failedExecutor(executionContext([]), replacementPayload)
        ).catch((error: unknown) => error);
        expect(replaceFailure).toBeInstanceOf(JobActionRetryableError);
    });

    test("commits bounded host data and persists only redacted provider failures", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const monotonicTimes = [10, 17];
        const executor = createSystemHostExecutor({
            collect: () =>
                Promise.resolve({
                    architecture: "x64",
                    disk: { freeBytes: 500, path: "/", totalBytes: 1000 },
                    hostname: "dashboard-host",
                    memory: { freeBytes: 400, totalBytes: 1000 },
                    platform: "linux",
                    release: "6.8.0",
                    uptimeSeconds: 12,
                }),
            monotonicNowMs: () => monotonicTimes.shift() ?? 17,
        });
        expect(
            await Effect.runPromise(
                executor(executionContext(attempts), { key: "system.host" })
            )
        ).toEqual({ cacheKeys: ["system.host"], completedAtMs: 5000 });
        expect(attempts[0]).toMatchObject({ durationMs: 7, kind: "succeeded" });

        const failedAttempts: JobCacheAttemptCommit[] = [];
        const failure = await Effect.runPromise(
            createSystemHostExecutor({
                collect: () => Promise.reject(new Error("secret host path")),
                monotonicNowMs: (() => {
                    const values = [20, 23];
                    return () => values.shift() ?? 23;
                })(),
            })(executionContext(failedAttempts), { key: "system.host" })
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(failedAttempts).toEqual([
            {
                durationMs: 3,
                failureCode: "provider/system-host-unavailable",
                failureMessage: "System host projection could not be collected.",
                key: "system.host",
                kind: "failed",
            },
        ]);
        expect(JSON.stringify(failedAttempts)).not.toContain("secret host path");

        let invalidPayloadCollections = 0;
        const invalidPayloadExecution = createSystemHostExecutor({
            collect: () => {
                invalidPayloadCollections += 1;
                return Promise.reject(new Error("collector must not run"));
            },
        })(executionContext([]), { key: "different" });
        expect(Effect.runPromise(invalidPayloadExecution)).rejects.toBeInstanceOf(Error);
        expect(invalidPayloadCollections).toBe(0);
    });

    test("commits one aggregate Moltbook attempt and redacts collector failures", async () => {
        const attempts: JobCacheAttemptCommit[] = [];
        const times = [10, 19];
        const executor = createMoltbookDashboardExecutor({
            collector: testMoltbookCollector,
            monotonicNowMs: () => times.shift() ?? 19,
        });
        expect(
            await Effect.runPromise(
                executor(executionContext(attempts), {
                    key: "moltbook.dashboard",
                })
            )
        ).toEqual({ cacheKeys: ["moltbook.dashboard"], completedAtMs: 5000 });
        expect(attempts).toEqual([
            {
                durationMs: 9,
                entries: [
                    {
                        key: "moltbook.dashboard",
                        metadata: { kind: "dashboard" },
                        payload: testMoltbookDashboardSnapshot,
                        schemaId: "moltbook.dashboard.v1",
                        source: "moltbook.api",
                        ttlMs: 1_800_000,
                    },
                ],
                kind: "succeeded",
            },
        ]);

        const failedAttempts: JobCacheAttemptCommit[] = [];
        const secret = "private-provider-detail";
        const failure = await Effect.runPromise(
            createMoltbookDashboardExecutor({
                collector: {
                    collect: () => Promise.reject(new Error(secret)),
                },
                monotonicNowMs: (() => {
                    const values = [20, 24];
                    return () => values.shift() ?? 24;
                })(),
            })(executionContext(failedAttempts), { key: "moltbook.dashboard" })
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(failedAttempts).toEqual([
            {
                durationMs: 4,
                failureCode: "provider/moltbook-unavailable",
                failureMessage: "Moltbook dashboard projection could not be collected.",
                key: "moltbook.dashboard",
                kind: "failed",
            },
        ]);
        expect(JSON.stringify(failedAttempts)).not.toContain(secret);
    });

    test("commits one exact domain-only database snapshot and redacts failures", async () => {
        const payload = {
            databases: databaseObservabilityMetricDatabases.map((name) => ({
                cacheHitRatio: 100,
                committedTransactions: 0,
                connections: 0,
                name,
                rolledBackTransactions: 0,
                sizeBytes: 0,
            })),
            pgbouncer: {
                averageQueryMs: 0,
                averageTransactionMs: 0,
                clientConnections: 0,
                maxWaitSeconds: 0,
                serverConnections: 0,
                waitingClients: 0,
            },
            statements: [],
            summary: {
                activeConnections: 0,
                averageCacheHitRatio: 100,
                idleConnections: 0,
                maintenance: {
                    assessmentComplete: true,
                    assessedPhysicalBytes: 0,
                    estimatedReclaimableBytes: 0,
                    estimatedReclaimablePercent: 0,
                    highDeadTupleTableCount: 0,
                    requiresBloatReview: false,
                    slowStatementCount: 0,
                    status: "healthy" as const,
                    unassessedPhysicalBytes: 0,
                    unassessedTableCount: 0,
                },
                pgStatStatementsEnabled: false,
                totalConnections: 0,
                totalDatabaseSizeBytes: 0,
            },
            tableHealth: [],
            torrentCounts: {
                bitmagnet: { state: "unavailable" as const },
                comet: { state: "unavailable" as const },
            },
        };
        const attempts: JobCacheAttemptCommit[] = [];
        const executor = createDatabaseObservabilityExecutor({
            collector: { collect: () => Promise.resolve(payload) },
            monotonicNowMs: (() => {
                const values = [10, 15];
                return () => values.shift() ?? 15;
            })(),
        });
        expect(
            await Effect.runPromise(
                executor(executionContext(attempts), {
                    key: "database.observability",
                })
            )
        ).toEqual({ cacheKeys: ["database.observability"], completedAtMs: 5000 });
        expect(attempts).toEqual([
            {
                durationMs: 5,
                entries: [
                    {
                        key: "database.observability",
                        metadata: { kind: "database-observability" },
                        payload,
                        schemaId: "database.observability.v1",
                        source: "postgresql.pgbouncer",
                        ttlMs: 5_400_000,
                    },
                ],
                kind: "succeeded",
            },
        ]);

        const failedAttempts: JobCacheAttemptCommit[] = [];
        const secret = "postgresql://monitor:secret@127.0.0.1:6432/postgres";
        const failure = await Effect.runPromise(
            createDatabaseObservabilityExecutor({
                collector: { collect: () => Promise.reject(new Error(secret)) },
            })(executionContext(failedAttempts), { key: "database.observability" })
        ).catch((error: unknown) => error);
        expect(failure).toBeInstanceOf(JobActionRetryableError);
        expect(failedAttempts).toEqual([
            {
                durationMs: expect.any(Number),
                failureCode: "provider/database-observability-unavailable",
                failureMessage:
                    "Database observability projection could not be collected.",
                key: "database.observability",
                kind: "failed",
            },
        ]);
        expect(JSON.stringify(failedAttempts)).not.toContain(secret);
    });
});
