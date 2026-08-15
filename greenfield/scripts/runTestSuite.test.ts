import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createBatchedTestCommand,
    createBatchedTestPlan,
    parseBatchedTestSuiteArguments,
    runBatchedTestSuite,
    type BatchedTestSuiteDependencies,
    type StagedTestTimingsUpdate,
} from "./runBatchedTestSuite.ts";
import { pruneMissingTestTimings } from "./runTestSuite.ts";
import {
    assertExactTimedTestPartition,
    createExactTimedTestInventory,
    createTimedTestBatchPlan,
    createTimingUpdateTestInventory,
    discoverReviewedSourceFiles,
    parseTestTimingsInventory,
    readTestTimingsInventory,
    runSequentialTestBatches,
    type TestTimingsInventory,
    type TimedTestBatch,
    type TimedTestFile,
} from "./testBatching.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const runnerPath = path.join(import.meta.dir, "runTestSuite.ts");
const temporaryDirectories: string[] = [];

interface RunnerResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
    readonly testRoot?: string;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function expectMissingPath(filePath: string): Promise<void> {
    let failure: unknown;
    try {
        await stat(filePath);
    } catch (error) {
        failure = error;
    }
    expect(failure).toMatchObject({ code: "ENOENT" });
}

async function runFixture(
    source: string,
    captureTestRoot = false
): Promise<RunnerResult> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-test-runner-"));
    temporaryDirectories.push(directory);
    const testPath = path.join(directory, "fixture.test.ts");
    const rootEvidencePath = path.join(directory, "test-root.txt");
    const instrumentedSource = captureTestRoot
        ? `
            import { writeFile as writeTestRootEvidence } from "node:fs/promises";
            const instrumentedTestRoot = process.env.MIRA_DASHBOARD_PROJECT_ROOT;
            if (instrumentedTestRoot === undefined) {
                throw new Error("Expected an instrumented test root");
            }
            await writeTestRootEvidence(
                ${JSON.stringify(rootEvidencePath)},
                instrumentedTestRoot,
                { encoding: "utf8", mode: 0o600 }
            );
            ${source}
        `
        : source;
    await writeFile(testPath, instrumentedSource, {
        encoding: "utf8",
        mode: 0o600,
    });

    const result = Bun.spawnSync([process.execPath, runnerPath, testPath], {
        cwd: projectRoot,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
        ...(captureTestRoot ? { testRoot: await Bun.file(rootEvidencePath).text() } : {}),
    };
}

describe("test suite runner", () => {
    test("rejects malformed or inexact timing inventories", () => {
        for (const inventory of [
            [],
            { files: [], version: 1 },
            { files: {}, version: 2 },
            { files: { "missing.test.ts": undefined }, version: 1 },
            { files: { "negative.test.ts": -1 }, version: 1 },
            { files: { "fraction.test.ts": 1.5 }, version: 1 },
            { files: { "unsafe.test.ts": Number.MAX_SAFE_INTEGER + 1 }, version: 1 },
        ]) {
            expect(() => parseTestTimingsInventory(inventory)).toThrow();
        }
        expect(
            parseTestTimingsInventory({
                files: { "zero.test.ts": 0 },
                version: 1,
            })
        ).toEqual({ files: { "zero.test.ts": 1 }, version: 1 });
    });

    test("prunes deleted files from Bun's merged timing inventory", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-test-timings-"));
        temporaryDirectories.push(directory);
        const existingTestPath = path.join(directory, "existing.test.ts");
        const zeroDurationTestPath = path.join(directory, "zero.test.ts");
        const deletedTestPath = path.join(directory, "deleted.test.ts");
        const timingsPath = path.join(directory, "timings.json");
        await Promise.all(
            [existingTestPath, zeroDurationTestPath].map((filePath) =>
                writeFile(filePath, "", { encoding: "utf8", mode: 0o600 })
            )
        );
        await writeFile(
            timingsPath,
            JSON.stringify({
                files: {
                    [existingTestPath]: 12,
                    [zeroDurationTestPath]: 0,
                    [deletedTestPath]: 9,
                },
                version: 1,
            }),
            { encoding: "utf8", mode: 0o600 }
        );

        await pruneMissingTestTimings(timingsPath, projectRoot);

        expect(await Bun.file(timingsPath).json()).toEqual({
            files: {
                [existingTestPath]: 12,
                [zeroDurationTestPath]: 1,
            },
            version: 1,
        });
    });

    test("preserves a passing test result", async () => {
        const result = await runFixture(`
            import { expect, test } from "bun:test";
            test("passes", () => expect(2 + 2).toBe(4));
        `);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("Test output policy failed");
    });

    test("fails a passing test that emits a React act warning", async () => {
        const result = await runFixture(`
            import { expect, test } from "bun:test";
            test("warns", () => {
                console.error("An update inside a test was not wrapped in act(...)");
                expect(true).toBe(true);
            });
        `);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
            "Test output policy failed: React update was not wrapped in act(...)."
        );
    });

    test("preserves a failing test result", async () => {
        const result = await runFixture(`
            import { expect, test } from "bun:test";
            test("fails", () => expect("actual").toBe("expected"));
        `);

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("actual");
    });

    test("removes runner-owned test roots after every terminal result", async () => {
        const scenarios = [
            {
                expectedExitCode: 0,
                source: `
                    import { expect, test } from "bun:test";
                    test("passes", () => expect(true).toBe(true));
                `,
            },
            {
                expectedExitCode: 1,
                source: `
                    import { expect, test } from "bun:test";
                    test("fails", () => expect("actual").toBe("expected"));
                `,
            },
            {
                expectedExitCode: 1,
                source: `
                    import { expect, test } from "bun:test";
                    test("warns", () => {
                        console.error("An update inside a test was not wrapped in act(...)");
                        expect(true).toBe(true);
                    });
                `,
            },
        ] as const;

        for (const scenario of scenarios) {
            const result = await runFixture(scenario.source, true);
            expect(result.exitCode).toBe(scenario.expectedExitCode);
            if (result.testRoot === undefined) {
                throw new Error("Expected captured test-root evidence");
            }
            await expectMissingPath(result.testRoot);
            await expectMissingPath(path.dirname(result.testRoot));
        }
    });
});

const fixtureInventoryPolicy = {
    inventoryName: "fixture timing inventory",
    isTestFile: (filePath: string) => filePath.endsWith(".test.ts"),
};
const fixtureBatchPolicy = {
    batchCount: 3,
    inventoryName: "fixture tests",
    namePrefix: "fixture",
};
const fixtureTimedTests: readonly TimedTestFile[] = Object.freeze([
    { durationMs: 90, filePath: "a.test.ts" },
    { durationMs: 80, filePath: "b.test.ts" },
    { durationMs: 70, filePath: "c.test.ts" },
    { durationMs: 30, filePath: "d.test.ts" },
    { durationMs: 20, filePath: "e.test.ts" },
    { durationMs: 10, filePath: "f.test.ts" },
]);

function fixtureSources(prefix: string): readonly string[] {
    return Array.from({ length: 6 }, (_, index) => `${prefix}/fixture-${index}.test.ts`);
}

function fixtureTimings(files: readonly string[]): TestTimingsInventory {
    return {
        files: Object.fromEntries(
            files.map((filePath, index) => [filePath, (index + 1) * 10])
        ),
        version: 1,
    };
}

describe("shared deterministic test batching", () => {
    test("matches exact inventories and assigns provisional update weights", () => {
        expect(
            createExactTimedTestInventory(
                ["a.test.ts", "support.ts", "b.test.ts"],
                { files: { "a.test.ts": 10, "b.test.ts": 20 }, version: 1 },
                fixtureInventoryPolicy
            )
        ).toEqual([
            { durationMs: 10, filePath: "a.test.ts" },
            { durationMs: 20, filePath: "b.test.ts" },
        ]);
        expect(() =>
            createExactTimedTestInventory(
                ["a.test.ts", "b.test.ts"],
                { files: { "a.test.ts": 10 }, version: 1 },
                fixtureInventoryPolicy
            )
        ).toThrow("files missing from fixture timing inventory:\nb.test.ts");
        expect(() =>
            createExactTimedTestInventory(
                ["a.test.ts"],
                { files: { "a.test.ts": 10, "b.test.ts": 20 }, version: 1 },
                fixtureInventoryPolicy
            )
        ).toThrow("unexpected fixture timing inventory files:\nb.test.ts");
        expect(() =>
            createExactTimedTestInventory(
                ["a.test.ts", "a.test.ts"],
                { files: { "a.test.ts": 10 }, version: 1 },
                fixtureInventoryPolicy
            )
        ).toThrow("duplicate discovered files:\na.test.ts");
        expect(
            createTimingUpdateTestInventory(
                ["a.test.ts", "new.test.ts"],
                {
                    files: { "a.test.ts": 10, "deleted.test.ts": 80 },
                    version: 1,
                },
                fixtureInventoryPolicy
            )
        ).toEqual([
            { durationMs: 10, filePath: "a.test.ts" },
            { durationMs: 80, filePath: "new.test.ts" },
        ]);
    });

    test("creates stable count-capped LPT plans and rejects unsafe partitions", () => {
        const plans = createTimedTestBatchPlan(fixtureTimedTests, fixtureBatchPolicy);
        expect(plans.map(({ name }) => name)).toEqual([
            "fixture-001",
            "fixture-002",
            "fixture-003",
        ]);
        expect(
            createTimedTestBatchPlan(fixtureTimedTests.toReversed(), fixtureBatchPolicy)
        ).toEqual(plans);
        expect(Math.max(...plans.map(({ testFiles }) => testFiles.length))).toBe(2);

        const [firstPlan, ...remainingPlans] = plans;
        const missingPlans: readonly TimedTestBatch[] = [
            {
                durationMs: firstPlan?.durationMs ?? 0,
                testFiles: firstPlan?.testFiles.slice(1) ?? [],
            },
            ...remainingPlans,
        ];
        expect(() =>
            assertExactTimedTestPartition(
                fixtureTimedTests,
                missingPlans,
                "fixture partition"
            )
        ).toThrow("files missing from fixture partition");
        expect(() =>
            createTimedTestBatchPlan(
                [...fixtureTimedTests, fixtureTimedTests[0] as TimedTestFile],
                fixtureBatchPolicy
            )
        ).toThrow("contains duplicate timed files");
        expect(() =>
            createTimedTestBatchPlan(
                [
                    ...fixtureTimedTests,
                    { durationMs: Number.NaN, filePath: "bad.test.ts" },
                ],
                fixtureBatchPolicy
            )
        ).toThrow("Invalid fixture tests timing duration");
        expect(
            createTimedTestBatchPlan(
                [
                    { durationMs: 0, filePath: "zero-a.test.ts" },
                    { durationMs: 0, filePath: "zero-b.test.ts" },
                    { durationMs: 0, filePath: "zero-c.test.ts" },
                ],
                fixtureBatchPolicy
            ).map(({ durationMs }) => durationMs)
        ).toEqual([1, 1, 1]);
    });

    test("runs plans sequentially and stops at the first failure", async () => {
        const calls: string[] = [];
        const plans = createTimedTestBatchPlan(fixtureTimedTests, fixtureBatchPolicy);
        expect(
            await runSequentialTestBatches(plans, async ({ name }) => {
                calls.push(name);
                await Promise.resolve();
                return name === "fixture-002" ? 23 : 0;
            })
        ).toBe(23);
        expect(calls).toEqual(["fixture-001", "fixture-002"]);
    });
});

describe("batched Bun and browser runner", () => {
    test("locks exact parallel-3 internally and covers all tracked files once", async () => {
        expect(parseBatchedTestSuiteArguments(["bun"])).toEqual({
            partition: "bun",
            updateTimings: false,
        });
        expect(parseBatchedTestSuiteArguments(["browser", "--update-timings"])).toEqual({
            partition: "browser",
            updateTimings: true,
        });
        for (const arguments_ of [
            ["bun", "--parallel=2"],
            ["bun", "--parallel=3"],
            ["bun", "--update-timings", "--update-timings"],
        ]) {
            expect(() => parseBatchedTestSuiteArguments(arguments_)).toThrow();
        }

        const sources = await discoverReviewedSourceFiles(
            projectRoot,
            "repository test inventory"
        );
        const [bunTimings, browserTimings] = await Promise.all([
            readTestTimingsInventory(".bun-test-timings.json", projectRoot),
            readTestTimingsInventory(".bun-browser-test-timings.json", projectRoot),
        ]);
        const bunPlans = createBatchedTestPlan("bun", false, sources, bunTimings);
        const browserPlans = createBatchedTestPlan(
            "browser",
            false,
            sources,
            browserTimings
        );
        expect(bunPlans.flatMap(({ testFiles }) => testFiles)).toHaveLength(508);
        expect(browserPlans.flatMap(({ testFiles }) => testFiles)).toHaveLength(185);
        expect(new Set(bunPlans.flatMap(({ testFiles }) => testFiles)).size).toBe(508);
        expect(new Set(browserPlans.flatMap(({ testFiles }) => testFiles)).size).toBe(
            185
        );
        expect(Math.max(...bunPlans.map(({ testFiles }) => testFiles.length))).toBe(170);
        expect(Math.max(...browserPlans.map(({ testFiles }) => testFiles.length))).toBe(
            62
        );
    });

    test("builds explicit commands and stops before later batches on failure", async () => {
        const sources = fixtureSources("src/worker");
        const timings = fixtureTimings(sources);
        const firstPlan = createBatchedTestPlan("bun", false, sources, timings)[0];
        expect(firstPlan).toBeDefined();
        const command = createBatchedTestCommand(
            "bun",
            firstPlan as NonNullable<typeof firstPlan>,
            ".bun-test-timings.json",
            false
        );
        expect(command.filter((argument) => argument === "--parallel=3")).toEqual([
            "--parallel=3",
        ]);
        expect(command.filter((argument) => argument === "--no-isolate")).toEqual([
            "--no-isolate",
        ]);

        const commands: string[][] = [];
        let active = false;
        let discoveryCalls = 0;
        const dependencies: BatchedTestSuiteDependencies = {
            commitTimingsUpdate: () =>
                Promise.reject(new Error("must not commit timings")),
            createTimingsUpdateStage: () =>
                Promise.reject(new Error("must not stage timings")),
            discoverSources: () => {
                discoveryCalls += 1;
                return Promise.resolve(sources);
            },
            projectRoot: "/tmp/project",
            pruneTimings: () => Promise.reject(new Error("must not prune timings")),
            readTimings: () => Promise.resolve(timings),
            removeTimingsUpdateStage: () =>
                Promise.reject(new Error("must not clean absent stage")),
            runCommand: async (command) => {
                expect(active).toBeFalse();
                active = true;
                await Promise.resolve();
                commands.push([...command]);
                active = false;
                return commands.length === 2 ? 23 : 0;
            },
        };

        expect(await runBatchedTestSuite("bun", false, dependencies)).toBe(23);
        expect(commands).toHaveLength(2);
        expect(discoveryCalls).toBe(1);
    });

    test("commits a staged timing update only after all batches validate", async () => {
        const sources = fixtureSources("src/worker");
        const oldTimings = fixtureTimings(sources.slice(0, 5));
        const finalTimings = fixtureTimings(sources);
        const stage: StagedTestTimingsUpdate = {
            directory: "/tmp/stage",
            timingsPath: "/tmp/stage/timings.json",
        };
        const events: string[] = [];
        let reads = 0;
        const dependencies: BatchedTestSuiteDependencies = {
            commitTimingsUpdate: () => {
                events.push("commit");
                return Promise.resolve();
            },
            createTimingsUpdateStage: () => {
                events.push("stage");
                return Promise.resolve(stage);
            },
            discoverSources: () => Promise.resolve(sources),
            projectRoot: "/tmp/project",
            pruneTimings: (timingsPath) => {
                expect(timingsPath).toBe(stage.timingsPath);
                events.push("prune");
                return Promise.resolve();
            },
            readTimings: (timingsPath) => {
                reads += 1;
                expect(timingsPath).toBe(
                    reads === 1 ? ".bun-test-timings.json" : stage.timingsPath
                );
                return Promise.resolve(reads === 1 ? oldTimings : finalTimings);
            },
            removeTimingsUpdateStage: () => {
                events.push("cleanup");
                return Promise.resolve();
            },
            runCommand: (command) => {
                expect(command).toContain(`--timings=${stage.timingsPath}`);
                expect(command).toContain("--update-timings");
                events.push("test");
                return Promise.resolve(0);
            },
        };

        expect(await runBatchedTestSuite("bun", true, dependencies)).toBe(0);
        expect(events).toEqual([
            "stage",
            "test",
            "test",
            "test",
            "prune",
            "commit",
            "cleanup",
        ]);
    });

    test("leaves tracked timings untouched when an update batch fails", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-timing-atomic-"));
        temporaryDirectories.push(directory);
        const trackedPath = path.join(directory, ".bun-test-timings.json");
        const originalBytes = '{"files":{"old.test.ts":10},"version":1}\n';
        await writeFile(trackedPath, originalBytes, {
            encoding: "utf8",
            mode: 0o600,
        });

        const sources = fixtureSources("src/worker");
        let testCalls = 0;
        let commits = 0;
        let prunes = 0;
        const dependencies: BatchedTestSuiteDependencies = {
            commitTimingsUpdate: () => {
                commits += 1;
                return Promise.resolve();
            },
            createTimingsUpdateStage: async () => {
                const stageDirectory = await mkdtemp(
                    path.join(directory, "private-stage-")
                );
                const timingsPath = path.join(stageDirectory, "timings.json");
                await writeFile(timingsPath, "private mutation", {
                    encoding: "utf8",
                    mode: 0o600,
                });
                return { directory: stageDirectory, timingsPath };
            },
            discoverSources: () => Promise.resolve(sources),
            projectRoot: directory,
            pruneTimings: () => {
                prunes += 1;
                return Promise.resolve();
            },
            readTimings: () => Promise.resolve(fixtureTimings(sources)),
            removeTimingsUpdateStage: ({ directory: stageDirectory }) =>
                rm(stageDirectory, { force: true, recursive: true }),
            runCommand: () => {
                testCalls += 1;
                return Promise.resolve(testCalls === 2 ? 17 : 0);
            },
        };

        expect(await runBatchedTestSuite("bun", true, dependencies)).toBe(17);
        expect(await Bun.file(trackedPath).text()).toBe(originalBytes);
        expect(testCalls).toBe(2);
        expect(prunes).toBe(0);
        expect(commits).toBe(0);
    });
});
