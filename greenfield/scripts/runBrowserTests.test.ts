import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
    type BrowserTestInventory,
    type BrowserTestPartition,
    browserTestPartitionForPath,
    browserTestPartitionOwnsPath,
    browserTestPartitions,
    createBrowserTestArguments,
    createBrowserTestInventory,
    discoverBrowserTestInventory,
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
const injectedInventory: BrowserTestInventory = createBrowserTestInventory(
    "/tmp/project",
    [
        "src/browser/example.test.ts",
        "src/browser/jobs/example.test.ts",
        ...isolatedJobTestOwners.keys(),
    ]
);

describe("browser test shard runner", () => {
    test("builds exact, isolated, deterministic shard arguments", async () => {
        const discoveredTestPathGroups = await Promise.all(
            ["src/browser/**/*.test.ts", "src/browser/**/*.test.tsx"].map((pattern) =>
                Array.fromAsync(
                    new Bun.Glob(pattern).scan({
                        cwd: projectRoot,
                        onlyFiles: true,
                    })
                )
            )
        );
        const discoveredTestPaths = discoveredTestPathGroups.flat();
        const testPaths = discoveredTestPaths.toSorted();
        const inventory = discoverBrowserTestInventory(projectRoot);
        const partitionPaths: string[] = [];
        for (const partition of browserTestPartitions) {
            const ownedPaths = testPaths.filter((testPath) =>
                browserTestPartitionOwnsPath(partition.name, testPath)
            );
            expect(createBrowserTestArguments(partition.name, inventory)).toEqual([
                "--preload",
                "./src/browser/test/setup.ts",
                "--max-concurrency=1",
                "--bail=1",
                ...ownedPaths.map((testPath) => path.resolve(projectRoot, testPath)),
            ]);
            partitionPaths.push(...ownedPaths);
        }
        expect(partitionPaths.toSorted()).toEqual(testPaths);
        expect(new Set(partitionPaths).size).toBe(testPaths.length);
        expect(
            createBrowserTestArguments("core", inventory).some((argument) =>
                argument.startsWith("--path-ignore-patterns=")
            )
        ).toBeFalse();
    });

    test("rejects invalid, duplicate, or incomplete inventories before execution", () => {
        expect(() =>
            createBrowserTestInventory("/tmp/project", ["src/server/example.test.ts"])
        ).toThrow("Invalid discovered browser-test path");
        expect(() =>
            createBrowserTestInventory("/tmp/project", [
                "src/browser/../server/example.test.ts",
            ])
        ).toThrow("Invalid discovered browser-test path");
        expect(() =>
            createBrowserTestInventory("/tmp/project", [
                "src/browser/example.test.ts",
                "./src/browser/example.test.ts",
            ])
        ).toThrow("duplicate paths");
        expect(() =>
            createBrowserTestInventory("/tmp/project", ["src/browser/example.test.ts"])
        ).toThrow("partition has no discovered files");
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
        let discoveryCalls = 0;
        const exitCode = await runBrowserTestShards({
            discoverTests: (receivedProjectRoot) => {
                discoveryCalls += 1;
                expect(receivedProjectRoot).toBe("/tmp/project");
                return injectedInventory;
            },
            projectRoot: "/tmp/project",
            runTests: (arguments_, receivedProjectRoot) => {
                calls.push([...arguments_, receivedProjectRoot]);
                return Promise.resolve(calls.length === 2 ? 17 : 0);
            },
        });

        expect(exitCode).toBe(17);
        expect(discoveryCalls).toBe(1);
        expect(calls).toEqual([
            [...createBrowserTestArguments("core", injectedInventory), "/tmp/project"],
            [...createBrowserTestArguments("jobs", injectedInventory), "/tmp/project"],
        ]);
    });

    test("runs every later shard only after the previous shard passes", async () => {
        const calls: string[][] = [];
        const exitCode = await runBrowserTestShards({
            discoverTests: () => injectedInventory,
            projectRoot: "/tmp/project",
            runTests: (arguments_, receivedProjectRoot) => {
                calls.push([...arguments_, receivedProjectRoot]);
                return Promise.resolve(0);
            },
        });

        expect(exitCode).toBe(0);
        expect(calls).toEqual([
            [...createBrowserTestArguments("core", injectedInventory), "/tmp/project"],
            [...createBrowserTestArguments("jobs", injectedInventory), "/tmp/project"],
            ...[...isolatedJobTestOwners.values()].map((partition) => [
                ...createBrowserTestArguments(partition, injectedInventory),
                "/tmp/project",
            ]),
        ]);
    });
});
