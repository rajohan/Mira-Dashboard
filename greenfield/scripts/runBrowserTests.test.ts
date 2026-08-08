import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
    type BrowserTestPartition,
    browserTestPartitionForPath,
    browserTestPartitionOwnsPath,
    browserTestPartitions,
    createBrowserTestArguments,
    runBrowserTestShards,
} from "./runBrowserTests.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const isolatedJobTestOwners: ReadonlyMap<string, BrowserTestPartition> = Object.freeze(
    new Map([
        ["src/browser/jobs/ScheduleDetailForm.test.tsx", "schedule-detail-form"],
        [
            "src/browser/jobs/ScheduleDetailStateDisable.test.tsx",
            "schedule-detail-state-disable",
        ],
        [
            "src/browser/jobs/ScheduleDetailStateErrors.test.tsx",
            "schedule-detail-state-errors",
        ],
        [
            "src/browser/jobs/ScheduleDetailStateVersion.test.tsx",
            "schedule-detail-state-version",
        ],
        [
            "src/browser/jobs/ScheduleDetailStateCopy.test.tsx",
            "schedule-detail-state-copy",
        ],
        [
            "src/browser/jobs/ScheduleDetailStateReplay.test.tsx",
            "schedule-detail-state-replay",
        ],
    ] as const)
);

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
            "--path-ignore-patterns=src/browser/jobs/{ScheduleDetailForm.test.tsx,ScheduleDetailStateDisable.test.tsx,ScheduleDetailStateErrors.test.tsx,ScheduleDetailStateVersion.test.tsx,ScheduleDetailStateCopy.test.tsx,ScheduleDetailStateReplay.test.tsx}",
            "src/browser/jobs",
        ]);
        for (const [testPath, owner] of isolatedJobTestOwners) {
            expect(createBrowserTestArguments(owner)).toEqual([
                "--preload",
                "./src/browser/test/setup.ts",
                "--max-concurrency=1",
                "--bail=1",
                testPath,
            ]);
        }
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
            const isolatedOwner = isolatedJobTestOwners.get(testPath);
            if (isolatedOwner !== undefined) {
                expect(owner).toBe(isolatedOwner);
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
            ...[...isolatedJobTestOwners.values()].map((partition) => [
                ...createBrowserTestArguments(partition),
                "/tmp/project",
            ]),
        ]);
    });
});
