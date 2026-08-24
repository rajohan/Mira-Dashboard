import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runTestProcess } from "./runTestSuite.ts";
import {
    createStorybookTestProjectPlan,
    discoverStorybookTestFiles,
    storybookTestProjectNames,
} from "./storybookTestProjects.ts";
import {
    assertExactTimedTestPartition,
    createExactTimedTestInventory,
    createTimedTestBatchPlan,
    createTimingUpdateTestInventory,
    normalizeMeasuredTestDuration,
    readTestTimingsInventory,
    runSequentialTestBatches,
    testBatchCount,
    testWorkerCount,
    type TimedTestBatchPlan,
    type TimedTestFile,
    type TestInventoryPolicy,
} from "./testBatching.ts";

export { discoverStorybookTestFiles } from "./storybookTestProjects.ts";

const storybookTimingsPath = ".storybook-test-timings.json";
const storybookCoverageExcludePatterns = Object.freeze([
    ".storybook/**",
    "**/*.stories.tsx",
    "src/browser/storySupport/**",
    "**/*.{spec,test}.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
    "**/test/**",
    "**/testSupport/**",
    "**/testSupport.{cjs,cts,js,jsx,mjs,mts,ts,tsx}",
]);

type StorybookTestProcess = (
    command: readonly string[],
    projectRoot: string
) => Promise<number>;

export interface StorybookTestRunOptions {
    readonly runProcess?: StorybookTestProcess;
    readonly timingsPath?: string;
    readonly updateTimings?: boolean;
}

/** Optional artifacts produced by one Storybook test child. */
export interface StorybookTestCommandOptions {
    readonly coverageDirectory?: string;
    readonly timingReportPath?: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryPath(projectRoot: string, absolutePath: string): string {
    const relativePath = path.relative(projectRoot, path.resolve(absolutePath));
    if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new TypeError(`Storybook timing report path escapes the repository`);
    }
    return relativePath.split(path.sep).join("/");
}

/**
 * Creates one pinned real-browser Storybook batch command.
 * @param projectRoot Repository root containing the pinned Vitest executable.
 * @param storyFiles Exact repository-relative story files in this batch.
 * @param options Optional private coverage or timing-report artifact paths.
 * @returns The exact batch command with three browser workers.
 */
export function createStorybookTestCommand(
    projectRoot: string,
    storyFiles: readonly string[],
    options: StorybookTestCommandOptions = {}
): readonly string[] {
    if (storyFiles.length === 0) {
        throw new TypeError("A Storybook test batch requires at least one story file");
    }
    if (
        options.coverageDirectory !== undefined &&
        !path.isAbsolute(options.coverageDirectory)
    ) {
        throw new TypeError("Storybook coverage directory must be absolute");
    }
    if (
        options.timingReportPath !== undefined &&
        !path.isAbsolute(options.timingReportPath)
    ) {
        throw new TypeError("Storybook timing report path must be absolute");
    }
    return Object.freeze([
        path.join(projectRoot, "node_modules", ".bin", "vitest"),
        "run",
        "--config",
        ".storybook/vitest.config.ts",
        ...storybookTestProjectNames.map((name) => `--project=${name}`),
        `--maxWorkers=${testWorkerCount}`,
        "--no-isolate",
        ...(options.coverageDirectory === undefined
            ? []
            : [
                  "--coverage",
                  "--coverage.provider=v8",
                  "--coverage.reporter=lcov",
                  `--coverage.reportsDirectory=${options.coverageDirectory}`,
                  `--coverage.processingConcurrency=${testWorkerCount}`,
                  "--coverage.excludeAfterRemap=true",
                  ...storybookCoverageExcludePatterns.map(
                      (pattern) => `--coverage.exclude=${pattern}`
                  ),
              ]),
        ...(options.timingReportPath === undefined
            ? []
            : [
                  "--reporter=default",
                  "--reporter=json",
                  `--outputFile.json=${options.timingReportPath}`,
              ]),
        ...storyFiles,
    ]);
}

/**
 * Parses one successful official Vitest JSON report into exact per-file timings.
 * @param value Decoded JSON reporter document.
 * @param expectedFiles Exact files passed to this Vitest child.
 * @param projectRoot Repository root used to normalize Vitest's absolute paths.
 * @returns Measured timings for the complete expected batch.
 */
export function parseStorybookTimingReport(
    value: unknown,
    expectedFiles: readonly string[],
    projectRoot: string
): readonly TimedTestFile[] {
    if (
        !isUnknownRecord(value) ||
        value.success !== true ||
        value.numFailedTestSuites !== 0 ||
        value.numFailedTests !== 0 ||
        value.numPendingTestSuites !== 0 ||
        value.numPendingTests !== 0 ||
        value.numTodoTests !== 0
    ) {
        throw new TypeError("Storybook timing report must describe a successful run");
    }
    const { testResults } = value;
    if (!Array.isArray(testResults)) {
        throw new TypeError("Storybook timing report must contain test results");
    }

    const expected = new Set(expectedFiles);
    const measured = testResults.map((result): TimedTestFile => {
        if (
            !isUnknownRecord(result) ||
            typeof result.name !== "string" ||
            result.status !== "passed" ||
            typeof result.startTime !== "number" ||
            !Number.isFinite(result.startTime) ||
            typeof result.endTime !== "number" ||
            !Number.isFinite(result.endTime) ||
            result.endTime < result.startTime
        ) {
            throw new TypeError("Storybook timing report contains an invalid result");
        }
        const testFile = repositoryPath(projectRoot, result.name);
        if (!expected.has(testFile)) {
            throw new TypeError(
                `Storybook timing report contains unexpected file: ${testFile}`
            );
        }
        const durationMs = normalizeMeasuredTestDuration(
            Math.round(result.endTime - result.startTime),
            `Storybook timing report has invalid duration: ${testFile}`
        );
        return { durationMs, filePath: testFile };
    });
    assertExactTimedTestPartition(
        expectedFiles.map((filePath) => ({ durationMs: 0, filePath })),
        [{ durationMs: 0, testFiles: measured.map(({ filePath }) => filePath) }],
        "Storybook timing report"
    );
    return Object.freeze(measured);
}

async function writeStorybookTimings(
    timingsPath: string,
    timings: readonly TimedTestFile[]
): Promise<void> {
    const sortedTimings = timings.toSorted((left, right) =>
        left.filePath.localeCompare(right.filePath)
    );
    const temporaryPath = `${timingsPath}.${process.pid}.tmp`;
    try {
        await writeFile(
            temporaryPath,
            `${JSON.stringify(
                {
                    files: Object.fromEntries(
                        sortedTimings.map(({ durationMs, filePath }) => [
                            filePath,
                            durationMs,
                        ])
                    ),
                    version: 1,
                },
                null,
                4
            )}\n`,
            { encoding: "utf8", mode: 0o600 }
        );
        await rename(temporaryPath, timingsPath);
    } finally {
        await rm(temporaryPath, { force: true });
    }
}

async function createStorybookTestBatches(
    projectRoot: string,
    timingsPath: string,
    updateTimings: boolean
): Promise<readonly TimedTestBatchPlan[]> {
    const discoveredFiles = await discoverStorybookTestFiles(projectRoot);
    createStorybookTestProjectPlan(discoveredFiles);
    const previousInventory = await readTestTimingsInventory(timingsPath, projectRoot);
    const policy: TestInventoryPolicy = {
        inventoryName: "Storybook test timing inventory",
        isTestFile: (filePath) => filePath.endsWith(".stories.tsx"),
    };
    const tests = updateTimings
        ? createTimingUpdateTestInventory(discoveredFiles, previousInventory, policy)
        : createExactTimedTestInventory(discoveredFiles, previousInventory, policy);
    const batches = createTimedTestBatchPlan(tests, {
        batchCount: testBatchCount,
        inventoryName: "Storybook test timing inventory",
        namePrefix: "storybook",
    });
    assertExactTimedTestPartition(tests, batches, "Storybook test batches");
    return batches;
}

/**
 * Runs complete, deterministic Storybook batches with three workers per child.
 * Timing updates use Vitest's supported JSON reporter and commit atomically only after
 * every batch passes the repository output policy.
 * @param projectRoot Repository root used for discovery and child execution.
 * @param options Optional test seams and timing-update mode.
 * @returns The first child failure code, or zero after every batch succeeds.
 */
export async function runStorybookTests(
    projectRoot = path.resolve(import.meta.dir, ".."),
    options: StorybookTestRunOptions = {}
): Promise<number> {
    const timingsPath = path.resolve(
        projectRoot,
        options.timingsPath ?? storybookTimingsPath
    );
    const updateTimings = options.updateTimings ?? false;
    const batches = await createStorybookTestBatches(
        projectRoot,
        timingsPath,
        updateTimings
    );
    const runProcess = options.runProcess ?? runTestProcess;

    if (!updateTimings) {
        return runSequentialTestBatches(batches, (batch) =>
            runProcess(
                createStorybookTestCommand(projectRoot, batch.testFiles),
                projectRoot
            )
        );
    }

    const reportsDirectory = await mkdtemp(
        path.join(tmpdir(), "mira-storybook-timings-")
    );
    const measuredTimings: TimedTestFile[] = [];
    let batchIndex = 0;
    try {
        const exitCode = await runSequentialTestBatches(batches, async (batch) => {
            const reportPath = path.join(
                reportsDirectory,
                `batch-${String(batchIndex++).padStart(2, "0")}.json`
            );
            const childExitCode = await runProcess(
                createStorybookTestCommand(projectRoot, batch.testFiles, {
                    timingReportPath: reportPath,
                }),
                projectRoot
            );
            if (childExitCode !== 0) return childExitCode;

            const report: unknown = await Bun.file(reportPath).json();
            measuredTimings.push(
                ...parseStorybookTimingReport(report, batch.testFiles, projectRoot)
            );
            return 0;
        });
        if (exitCode !== 0) return exitCode;

        assertExactTimedTestPartition(
            batches.flatMap((batch) =>
                batch.testFiles.map((filePath) => ({ durationMs: 0, filePath }))
            ),
            [
                {
                    durationMs: 0,
                    testFiles: measuredTimings.map(({ filePath }) => filePath),
                },
            ],
            "Storybook timing update"
        );
        await writeStorybookTimings(timingsPath, measuredTimings);
        return 0;
    } finally {
        await rm(reportsDirectory, { force: true, recursive: true });
    }
}

if (import.meta.main) {
    const arguments_ = process.argv.slice(2);
    if (
        arguments_.length > 1 ||
        (arguments_[0] !== undefined && arguments_[0] !== "--update-timings")
    ) {
        throw new TypeError("Usage: bun scripts/runStorybookTests.ts [--update-timings]");
    }
    process.exitCode = await runStorybookTests(path.resolve(import.meta.dir, ".."), {
        updateTimings: arguments_[0] === "--update-timings",
    });
}
