import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
    createJobWorkerActionResolver,
    createLogMaintenanceJobExecutor,
    createSystemHostExecutor,
    createWorkspaceFileWriteJobExecutor,
    createJobWorkerActionRegistry,
    type WorkspaceFileWriteExecutionPort,
} from "./actionExecutors.ts";
import {
    type JobActionExecutionContext,
    type JobCacheAttemptCommit,
    JobActionRetryableError,
    jobActionDefinitions,
} from "./actionRegistry.ts";

function executionContext(attempts: JobCacheAttemptCommit[]): JobActionExecutionContext {
    return {
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
    test("matches every pure definition with one exact executor", () => {
        const findAction = createJobWorkerActionResolver({
            run: () => Promise.resolve(),
        });
        expect(findAction("system.worker-smoke")).toBeDefined();
        expect(findAction("cache.refresh.system-host")).toBeDefined();
        expect(findAction("maintenance.rotate-logs")).toBeDefined();
        expect(findAction("system.shell")).toBeUndefined();
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
                    run: () => Promise.resolve(),
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

        const findAction = createJobWorkerActionResolver(
            { run: () => Promise.resolve() },
            writer
        );
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
});
