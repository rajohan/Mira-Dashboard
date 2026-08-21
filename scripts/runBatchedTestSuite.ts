import { copyFile, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pruneMissingTestTimings, runTestProcess } from "./runTestSuite.ts";
import {
    createExactTimedTestInventory,
    createTimedTestBatchPlan,
    createTimingUpdateTestInventory,
    discoverReviewedSourceFiles,
    readTestTimingsInventory,
    runSequentialTestBatches,
    testBatchCount,
    testWorkerCount,
    type TestTimingsInventory,
    type TimedTestBatchPlan,
    type TimedTestFile,
} from "./testBatching.ts";

const testFilePattern = /\.(?:spec|test)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/u;
const bunTestRoots = Object.freeze([
    "scripts/",
    "src/app/",
    "src/contracts/",
    "src/server/",
    "src/shared/",
    "src/test/",
    "src/worker/",
]);

/** Supported independently isolated Bun test partitions. */
export type BatchedTestPartition = "browser" | "bun";

interface BatchedTestPartitionPolicy {
    readonly inventoryName: string;
    readonly isTestFile: (filePath: string) => boolean;
    readonly namePrefix: string;
    readonly preload?: string;
    readonly timingsPath: string;
}

/** Private timing inventory used until every update batch passes. */
export interface StagedTestTimingsUpdate {
    readonly directory: string;
    readonly timingsPath: string;
}

/** Injectable side-effect boundary for the batched test orchestrator. */
export interface BatchedTestSuiteDependencies {
    readonly commitTimingsUpdate: (
        stage: StagedTestTimingsUpdate,
        targetPath: string,
        projectRoot: string
    ) => Promise<void>;
    readonly createTimingsUpdateStage: (
        sourcePath: string,
        projectRoot: string
    ) => Promise<StagedTestTimingsUpdate>;
    readonly discoverSources: (
        projectRoot: string,
        inventoryName: string
    ) => Promise<readonly string[]>;
    readonly projectRoot: string;
    readonly pruneTimings: (timingsPath: string, projectRoot: string) => Promise<void>;
    readonly readTimings: (
        timingsPath: string,
        projectRoot: string
    ) => Promise<TestTimingsInventory>;
    readonly removeTimingsUpdateStage: (stage: StagedTestTimingsUpdate) => Promise<void>;
    readonly runCommand: (
        command: readonly string[],
        projectRoot: string
    ) => Promise<number>;
}

function isBrowserTestFile(filePath: string): boolean {
    return filePath.startsWith("src/browser/") && testFilePattern.test(filePath);
}

function isBunTestFile(filePath: string): boolean {
    return (
        bunTestRoots.some((root) => filePath.startsWith(root)) &&
        testFilePattern.test(filePath)
    );
}

function partitionPolicy(partition: BatchedTestPartition): BatchedTestPartitionPolicy {
    if (partition === "browser") {
        return Object.freeze({
            inventoryName: "browser test timing inventory",
            isTestFile: isBrowserTestFile,
            namePrefix: "browser",
            preload: "./src/browser/test/setup.ts",
            timingsPath: ".bun-browser-test-timings.json",
        });
    }
    return Object.freeze({
        inventoryName: "Bun test timing inventory",
        isTestFile: isBunTestFile,
        namePrefix: "bun",
        timingsPath: ".bun-test-timings.json",
    });
}

/**
 * Parses the deliberately narrow batched-runner CLI.
 * @param arguments_ Arguments after the runner script.
 * @returns Exact partition and optional timing-update mode.
 */
export function parseBatchedTestSuiteArguments(arguments_: readonly string[]): {
    readonly partition: BatchedTestPartition;
    readonly updateTimings: boolean;
} {
    const [partition, ...options] = arguments_;
    if (partition !== "bun" && partition !== "browser") {
        throw new TypeError("Batched test partition must be bun or browser");
    }
    const expectedOptions = new Set(["--update-timings"]);
    const unexpectedOptions = options.filter((option) => !expectedOptions.has(option));
    if (unexpectedOptions.length > 0) {
        throw new TypeError(
            `Unexpected batched test arguments: ${unexpectedOptions.join(", ")}`
        );
    }
    if (options.filter((option) => option === "--update-timings").length > 1) {
        throw new TypeError("Batched test runner accepts --update-timings only once");
    }
    return Object.freeze({
        partition,
        updateTimings: options.includes("--update-timings"),
    });
}

/**
 * Builds the exact fresh-worker command for one Bun or browser batch.
 * @param partition Test runtime partition.
 * @param batch Explicit files assigned by the shared batching engine.
 * @param timingsPath Tracked or private update timing inventory.
 * @param updateTimings Whether Bun may update the private timing inventory.
 * @returns Complete child command.
 */
export function createBatchedTestCommand(
    partition: BatchedTestPartition,
    batch: TimedTestBatchPlan,
    timingsPath: string,
    updateTimings: boolean
): readonly string[] {
    if (batch.testFiles.length === 0) {
        throw new TypeError("Batched test command requires explicit test files");
    }
    const policy = partitionPolicy(partition);
    return Object.freeze([
        process.execPath,
        "test",
        `--timings=${timingsPath}`,
        "--bail=1",
        "--only-failures",
        `--parallel=${testWorkerCount}`,
        "--no-isolate",
        ...(updateTimings ? ["--update-timings"] : []),
        ...(policy.preload === undefined ? [] : ["--preload", policy.preload]),
        ...batch.testFiles,
    ]);
}

/**
 * Loads the actual partition graph and creates its exact three-batch plan.
 * @param partition Bun or browser partition.
 * @param updateTimings Whether newly discovered files receive provisional weights.
 * @param discoveredSources Reviewed source inventory.
 * @param timings Existing timing inventory.
 * @returns Three deterministic duration-balanced batches.
 */
export function createBatchedTestPlan(
    partition: BatchedTestPartition,
    updateTimings: boolean,
    discoveredSources: readonly string[],
    timings: TestTimingsInventory
): readonly TimedTestBatchPlan[] {
    const policy = partitionPolicy(partition);
    const inventory = updateTimings
        ? createTimingUpdateTestInventory(discoveredSources, timings, policy)
        : createExactTimedTestInventory(discoveredSources, timings, policy);
    return createTimedTestBatchPlan(inventory, {
        batchCount: testBatchCount,
        inventoryName: policy.inventoryName,
        namePrefix: policy.namePrefix,
    });
}

export async function createTimingsUpdateStage(
    sourcePath: string,
    projectRoot: string
): Promise<StagedTestTimingsUpdate> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-test-timings-"));
    const timingsPath = path.join(directory, path.basename(sourcePath));
    await copyFile(path.resolve(projectRoot, sourcePath), timingsPath);
    return Object.freeze({ directory, timingsPath });
}

export async function commitTimingsUpdate(
    stage: StagedTestTimingsUpdate,
    targetPath: string,
    projectRoot: string
): Promise<void> {
    const resolvedTargetPath = path.resolve(projectRoot, targetPath);
    const temporaryTargetPath = `${resolvedTargetPath}.${process.pid}.tmp`;
    try {
        await copyFile(stage.timingsPath, temporaryTargetPath);
        await rename(temporaryTargetPath, resolvedTargetPath);
    } finally {
        await rm(temporaryTargetPath, { force: true });
    }
}

export async function removeTimingsUpdateStage(
    stage: StagedTestTimingsUpdate
): Promise<void> {
    await rm(stage.directory, { force: true, recursive: true });
}

const defaultDependencies: BatchedTestSuiteDependencies = Object.freeze({
    commitTimingsUpdate,
    createTimingsUpdateStage,
    discoverSources: discoverReviewedSourceFiles,
    projectRoot: path.resolve(import.meta.dir, ".."),
    pruneTimings: pruneMissingTestTimings,
    readTimings: readTestTimingsInventory,
    removeTimingsUpdateStage,
    runCommand: runTestProcess,
});

function createExactInventory(
    partition: BatchedTestPartition,
    discoveredSources: readonly string[],
    timings: TestTimingsInventory
): readonly TimedTestFile[] {
    const policy = partitionPolicy(partition);
    return createExactTimedTestInventory(discoveredSources, timings, policy);
}

/**
 * Runs one complete partition in three sequential fresh-worker batches.
 * Timing updates remain private and replace the tracked file only after a fresh exact check.
 * @param partition Bun or browser partition.
 * @param updateTimings Whether to atomically refresh the timing inventory.
 * @param dependencies Injectable process and filesystem boundaries.
 * @returns Zero after all batches pass, otherwise the first child failure code.
 */
export async function runBatchedTestSuite(
    partition: BatchedTestPartition,
    updateTimings = false,
    dependencies: BatchedTestSuiteDependencies = defaultDependencies
): Promise<number> {
    const policy = partitionPolicy(partition);
    const [discoveredSources, timings] = await Promise.all([
        dependencies.discoverSources(dependencies.projectRoot, policy.inventoryName),
        dependencies.readTimings(policy.timingsPath, dependencies.projectRoot),
    ]);
    const batches = createBatchedTestPlan(
        partition,
        updateTimings,
        discoveredSources,
        timings
    );
    const stage = updateTimings
        ? await dependencies.createTimingsUpdateStage(
              policy.timingsPath,
              dependencies.projectRoot
          )
        : undefined;
    const activeTimingsPath = stage?.timingsPath ?? policy.timingsPath;

    try {
        const exitCode = await runSequentialTestBatches(batches, (batch) =>
            dependencies.runCommand(
                createBatchedTestCommand(
                    partition,
                    batch,
                    activeTimingsPath,
                    updateTimings
                ),
                dependencies.projectRoot
            )
        );
        if (exitCode !== 0) return exitCode;

        if (stage !== undefined) {
            await dependencies.pruneTimings(stage.timingsPath, dependencies.projectRoot);
        }
        const [finalSources, finalTimings] = await Promise.all([
            dependencies.discoverSources(dependencies.projectRoot, policy.inventoryName),
            dependencies.readTimings(activeTimingsPath, dependencies.projectRoot),
        ]);
        createExactInventory(partition, finalSources, finalTimings);
        if (stage !== undefined) {
            await dependencies.commitTimingsUpdate(
                stage,
                policy.timingsPath,
                dependencies.projectRoot
            );
        }
        return 0;
    } finally {
        if (stage !== undefined) {
            await dependencies.removeTimingsUpdateStage(stage);
        }
    }
}

if (import.meta.main) {
    const { partition, updateTimings } = parseBatchedTestSuiteArguments(
        process.argv.slice(2)
    );
    process.exitCode = await runBatchedTestSuite(partition, updateTimings);
}
