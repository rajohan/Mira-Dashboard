import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
    browserTestPartitionForPath,
    browserTestPartitionOwnsPath,
    browserTestPartitions,
    createBrowserTestArguments,
    runBrowserTestShards,
} from "./runBrowserTests.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

describe("browser test shard runner", () => {
    test("builds exact, isolated, deterministic shard arguments", () => {
        expect(createBrowserTestArguments("core")).toEqual([
            "--preload",
            "./src/browser/test/setup.ts",
            "--max-concurrency=1",
            "--bail=1",
            "--path-ignore-patterns=src/browser/jobs/**",
            "src/browser",
        ]);
        expect(createBrowserTestArguments("jobs")).toEqual([
            "--preload",
            "./src/browser/test/setup.ts",
            "--max-concurrency=1",
            "--bail=1",
            "--path-ignore-patterns=src/browser/jobs/ScheduleDetail{Form,State}.test.tsx",
            "src/browser/jobs",
        ]);
        expect(createBrowserTestArguments("schedule-detail-form")).toEqual([
            "--preload",
            "./src/browser/test/setup.ts",
            "--max-concurrency=1",
            "--bail=1",
            "src/browser/jobs/ScheduleDetailForm.test.tsx",
        ]);
        expect(createBrowserTestArguments("schedule-detail-state")).toEqual([
            "--preload",
            "./src/browser/test/setup.ts",
            "--max-concurrency=1",
            "--bail=1",
            "src/browser/jobs/ScheduleDetailState.test.tsx",
        ]);
    });

    test("assigns every discovered browser test to exactly one shard", async () => {
        const testPaths = await Array.fromAsync(
            new Bun.Glob("src/browser/**/*.test.{ts,tsx}").scan({
                cwd: projectRoot,
                onlyFiles: true,
            })
        );

        expect(testPaths.length).toBeGreaterThan(0);
        for (const testPath of testPaths) {
            const owners = browserTestPartitions.filter((partition) =>
                browserTestPartitionOwnsPath(partition.name, testPath)
            );
            const owner = browserTestPartitionForPath(testPath);
            expect(owners).toHaveLength(1);
            expect(owner).toBe(owners[0]?.name);
            if (testPath === "src/browser/jobs/ScheduleDetailForm.test.tsx") {
                expect(owner).toBe("schedule-detail-form");
            } else if (testPath === "src/browser/jobs/ScheduleDetailState.test.tsx") {
                expect(owner).toBe("schedule-detail-state");
            } else if (testPath.startsWith("src/browser/jobs/")) {
                expect(owner).toBe("jobs");
            } else {
                expect(owner).toBe("core");
            }
        }
        expect(browserTestPartitionForPath("src/server/example.test.ts")).toBeUndefined();
        expect(
            browserTestPartitionForPath("src/browser/jobs/example.ts")
        ).toBeUndefined();
    });

    test("runs fresh shards sequentially and stops on the first failure", async () => {
        const calls: string[][] = [];
        const exitCode = await runBrowserTestShards({
            projectRoot: "/tmp/project",
            runTests: (arguments_, receivedProjectRoot) => {
                calls.push([...arguments_, receivedProjectRoot]);
                return Promise.resolve(calls.length === 2 ? 17 : 0);
            },
        });

        expect(exitCode).toBe(17);
        expect(calls).toEqual([
            [...createBrowserTestArguments("core"), "/tmp/project"],
            [...createBrowserTestArguments("jobs"), "/tmp/project"],
        ]);
    });

    test("runs every later shard only after the previous shard passes", async () => {
        const calls: string[][] = [];
        const exitCode = await runBrowserTestShards({
            projectRoot: "/tmp/project",
            runTests: (arguments_, receivedProjectRoot) => {
                calls.push([...arguments_, receivedProjectRoot]);
                return Promise.resolve(0);
            },
        });

        expect(exitCode).toBe(0);
        expect(calls).toEqual([
            [...createBrowserTestArguments("core"), "/tmp/project"],
            [...createBrowserTestArguments("jobs"), "/tmp/project"],
            [...createBrowserTestArguments("schedule-detail-form"), "/tmp/project"],
            [...createBrowserTestArguments("schedule-detail-state"), "/tmp/project"],
        ]);
    });
});
