import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import {
    createSystemHostExecutor,
    createJobWorkerActionRegistry,
    findJobWorkerAction,
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
        expect(findJobWorkerAction("system.worker-smoke")).toBeDefined();
        expect(findJobWorkerAction("cache.refresh.system-host")).toBeDefined();
        expect(findJobWorkerAction("system.shell")).toBeUndefined();
    });

    test("fails closed for missing, extra, and duplicate executor keys", () => {
        expect(() =>
            createJobWorkerActionRegistry(jobActionDefinitions, [
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
            ])
        ).toThrow("do not exactly match");
        expect(() =>
            createJobWorkerActionRegistry(jobActionDefinitions, [
                { actionKey: "cache.refresh.system-host", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
                { actionKey: "system.extra", execute: successfulExecutor },
            ])
        ).toThrow("do not exactly match");
        expect(() =>
            createJobWorkerActionRegistry(jobActionDefinitions, [
                { actionKey: "cache.refresh.system-host", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
                { actionKey: "system.worker-smoke", execute: successfulExecutor },
            ])
        ).toThrow("do not exactly match");
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
