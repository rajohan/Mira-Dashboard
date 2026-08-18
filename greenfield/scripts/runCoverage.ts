import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { mergeCoverageReportFiles } from "lcov-result-merger";

import {
    checkCoverageFile,
    type LineCoverageSummary,
    requiredLineCoveragePercent,
} from "./checkCoverage.ts";
import { readBoundedUtf8RegularFile } from "./files/boundedFile.ts";
import { createStorybookTestCommand } from "./runStorybookTests.ts";
import { runTestProcess } from "./runTestSuite.ts";
import { isTestPath, sourceRole } from "./sourceBoundaries/sourceTopologyPolicy.ts";
import { createStorybookTestProjectPlan } from "./storybookTestProjects.ts";
import {
    createExactTimedTestInventory,
    createTimedTestBatchPlan,
    discoverReviewedSourceFiles,
    readTestTimingsInventory,
    runSequentialTestBatches,
    testBatchCount,
    testWorkerCount,
    type TimedTestFile,
} from "./testBatching.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const coverageDirectory = path.join(projectRoot, "coverage");
const coveredSourceRoots = Object.freeze([
    "scripts",
    "src",
    "drizzle.config.ts",
    "tailwind.config.ts",
]);
const browserTestTimingsFile = ".bun-browser-test-timings.json";
const bunTestTimingsFile = ".bun-test-timings.json";
const storybookTestTimingsFile = ".storybook-test-timings.json";
const browserTestPreload = "./src/browser/test/setup.ts";
const maximumPrivateLcovBytes = 64 * 1024 * 1024;
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

/** Independently executed test process contributing to merged LCOV. */
export type CoveragePartition = "browser" | "bun" | "storybook";

/** Local complete gate, one CI partition, or the CI artifact aggregator. */
export type CoverageRunMode = "all" | "browser" | "bun" | "merge" | "storybook";

/** Exact timed inventories for all three coverage runtime partitions. */
export interface CoverageTestInventories {
    readonly browser: readonly TimedTestFile[];
    readonly bun: readonly TimedTestFile[];
    readonly storybook: readonly TimedTestFile[];
}

/** One isolated coverage process and its private artifact paths. */
export interface CoveragePartitionPlan {
    readonly durationMs: number;
    readonly name: string;
    readonly outputDirectory: string;
    readonly partition: CoveragePartition;
    readonly reportPath: string;
    readonly testFiles: readonly string[];
}

/** Injectable side-effect boundary for the coverage orchestrator. */
export interface CoverageRunnerDependencies {
    readonly checkReport: (
        lcovPath: string,
        thresholdPercent: number,
        sourceRoots: readonly string[],
        projectRoot: string
    ) => Promise<LineCoverageSummary>;
    readonly coverageDirectory: string;
    readonly listArtifacts: (directory: string) => Promise<readonly string[]>;
    readonly loadTests: (projectRoot: string) => Promise<CoverageTestInventories>;
    readonly log: (message: string) => void;
    readonly mergeReports: (
        reportPaths: readonly string[],
        reportPattern: string
    ) => Promise<string>;
    readonly projectRoot: string;
    readonly resetDirectory: (directory: string) => Promise<void>;
    readonly runCommand: (
        command: readonly string[],
        projectRoot: string
    ) => Promise<number>;
    readonly validateStorybookReport: (
        reportPath: string,
        coverageDirectory: string
    ) => Promise<void>;
    readonly writeReport: (filePath: string, coverage: string) => Promise<void>;
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

function isStorybookTestFile(filePath: string): boolean {
    return filePath.endsWith(".stories.tsx");
}

/**
 * Loads actual Bun, browser, and Storybook graphs against exact timing inventories.
 * @param root Repository root containing reviewed sources and timing files.
 * @returns All three complete timed partitions.
 */
export async function loadCoverageTestInventories(
    root: string
): Promise<CoverageTestInventories> {
    const [sources, bunTimings, browserTimings, storybookTimings] = await Promise.all([
        discoverReviewedSourceFiles(root, "coverage test inventory"),
        readTestTimingsInventory(bunTestTimingsFile, root),
        readTestTimingsInventory(browserTestTimingsFile, root),
        readTestTimingsInventory(storybookTestTimingsFile, root),
    ]);
    createStorybookTestProjectPlan(
        sources.filter((filePath) => isStorybookTestFile(filePath))
    );
    return Object.freeze({
        browser: createExactTimedTestInventory(sources, browserTimings, {
            inventoryName: "browser coverage timing inventory",
            isTestFile: isBrowserTestFile,
        }),
        bun: createExactTimedTestInventory(sources, bunTimings, {
            inventoryName: "Bun coverage timing inventory",
            isTestFile: isBunTestFile,
        }),
        storybook: createExactTimedTestInventory(sources, storybookTimings, {
            inventoryName: "Storybook coverage timing inventory",
            isTestFile: isStorybookTestFile,
        }),
    });
}

/**
 * Creates nine deterministic coverage processes and their merge inventory.
 * @param directory Root directory for private and merged LCOV artifacts.
 * @param inventories Exact timed Bun, browser, and Storybook test inventories.
 * @returns Three Bun, three browser, and three Storybook plans in merge order.
 */
export function createCoveragePartitionPlan(
    directory: string,
    inventories: CoverageTestInventories
): readonly CoveragePartitionPlan[] {
    const partitions = (["bun", "browser", "storybook"] as const).flatMap((partition) =>
        createTimedTestBatchPlan(inventories[partition], {
            batchCount: testBatchCount,
            inventoryName: `${partition} coverage tests`,
            namePrefix: partition,
        }).map((batch) => ({ ...batch, partition }))
    );
    return Object.freeze(
        partitions.map(({ durationMs, name, partition, testFiles }) => {
            const outputDirectory = path.join(directory, name);
            return Object.freeze({
                durationMs,
                name,
                outputDirectory,
                partition,
                reportPath: path.join(outputDirectory, "lcov.info"),
                testFiles,
            });
        })
    );
}

/**
 * Selects the exact three-batch CI partition without changing the shared plan.
 * @param plans Complete deterministic coverage plan.
 * @param partition Runtime partition selected by one CI job.
 * @returns The exact three plans owned by that partition.
 */
export function selectCoveragePartitionPlans(
    plans: readonly CoveragePartitionPlan[],
    partition: CoveragePartition
): readonly CoveragePartitionPlan[] {
    const selectedPlans = plans.filter((plan) => plan.partition === partition);
    if (selectedPlans.length !== testBatchCount) {
        throw new Error(
            `${partition} coverage partition requires exactly ${testBatchCount} batches`
        );
    }
    return Object.freeze(selectedPlans);
}

function normalizeCoverageArtifactPath(directory: string, artifactPath: string): string {
    const relativePath = path.relative(directory, path.resolve(artifactPath));
    if (
        relativePath.length === 0 ||
        relativePath === ".." ||
        relativePath.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relativePath)
    ) {
        throw new Error("Coverage artifact inventory escapes its private directory");
    }
    return relativePath.replaceAll(path.sep, "/");
}

/**
 * Proves that downloaded coverage artifacts contain every expected report exactly once
 * and contain no stale or foreign files.
 * @param directory Root directory containing private coverage reports.
 * @param expectedReportPaths Exact report inventory derived from the shared batch plan.
 * @param artifactPaths Actual regular files discovered below the artifact root.
 */
export function assertExactCoverageArtifactInventory(
    directory: string,
    expectedReportPaths: readonly string[],
    artifactPaths: readonly string[]
): void {
    const expectedPaths = expectedReportPaths.map((reportPath) =>
        normalizeCoverageArtifactPath(directory, reportPath)
    );
    const actualPaths = artifactPaths.map((artifactPath) =>
        normalizeCoverageArtifactPath(directory, artifactPath)
    );
    if (new Set(expectedPaths).size !== expectedPaths.length) {
        throw new Error("Coverage plan contains duplicate report paths");
    }

    const actualCounts = new Map<string, number>();
    for (const artifactPath of actualPaths) {
        actualCounts.set(artifactPath, (actualCounts.get(artifactPath) ?? 0) + 1);
    }
    const expectedSet = new Set(expectedPaths);
    const missingPaths = expectedPaths.filter(
        (expectedPath) => !actualCounts.has(expectedPath)
    );
    const duplicatePaths = [...actualCounts]
        .filter(([, count]) => count > 1)
        .map(([artifactPath]) => artifactPath)
        .toSorted();
    const unexpectedPaths = [...actualCounts.keys()]
        .filter((artifactPath) => !expectedSet.has(artifactPath))
        .toSorted();

    if (
        missingPaths.length === 0 &&
        duplicatePaths.length === 0 &&
        unexpectedPaths.length === 0
    ) {
        return;
    }

    const findings = [
        ...(missingPaths.length === 0
            ? []
            : [`missing:\n${missingPaths.toSorted().join("\n")}`]),
        ...(duplicatePaths.length === 0
            ? []
            : [`duplicate:\n${duplicatePaths.join("\n")}`]),
        ...(unexpectedPaths.length === 0
            ? []
            : [`unexpected:\n${unexpectedPaths.join("\n")}`]),
    ];
    throw new Error(`Coverage artifact inventory mismatch\n${findings.join("\n")}`);
}

/**
 * Builds the exact Bun test arguments used by one coverage batch.
 * @param outputDirectory Directory where Bun writes private coverage artifacts.
 * @param partition Runtime partition selecting timing and preload policy.
 * @param testFiles Exact explicit files for one fresh-worker process.
 * @returns Complete arguments after `bun test`.
 */
export function createCoverageTestArguments(
    outputDirectory: string,
    partition: CoveragePartition,
    testFiles: readonly string[]
): readonly string[] {
    if (partition === "storybook") {
        throw new TypeError("Storybook coverage requires the Vitest command adapter");
    }
    if (testFiles.length === 0) {
        throw new TypeError("Coverage batch requires explicit test files");
    }
    return Object.freeze([
        `--timings=${partition === "browser" ? browserTestTimingsFile : bunTestTimingsFile}`,
        "--bail=1",
        "--only-failures",
        `--parallel=${testWorkerCount}`,
        "--no-isolate",
        "--coverage",
        "--coverage-reporter",
        "lcov",
        "--coverage-dir",
        outputDirectory,
        ...(partition === "browser" ? ["--preload", browserTestPreload] : []),
        ...testFiles,
    ]);
}

/**
 * Builds one complete Bun or Storybook coverage child command.
 * @param projectRoot Repository root containing the pinned test executables.
 * @param plan Exact private output path, partition, and explicit test files.
 * @returns Complete command executed through the shared output policy.
 */
export function createCoverageTestCommand(
    projectRoot: string,
    plan: CoveragePartitionPlan
): readonly string[] {
    if (plan.partition === "storybook") {
        return createStorybookTestCommand(projectRoot, plan.testFiles, {
            coverageDirectory: plan.outputDirectory,
        });
    }
    return Object.freeze([
        process.execPath,
        "test",
        ...createCoverageTestArguments(
            plan.outputDirectory,
            plan.partition,
            plan.testFiles
        ),
    ]);
}

function normalizeStorybookCoverageSource(value: string): string {
    return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

const emptyV8CoverageRecord = Object.freeze([
    "TN:",
    "SF:",
    "FNF:0",
    "FNH:0",
    "LF:0",
    "LH:0",
    "BRF:0",
    "BRH:0",
]);

function isEmptyV8CoverageRecord(lines: readonly string[]): boolean {
    return (
        lines.length === emptyV8CoverageRecord.length &&
        lines.every((line, index) => line === emptyV8CoverageRecord[index])
    );
}

function validateStorybookCoverageSource(filePath: string): boolean {
    const pathSegments = filePath.split("/");
    if (
        filePath.length === 0 ||
        filePath.includes("\0") ||
        pathSegments.some(
            (segment) => segment.length === 0 || segment === "." || segment === ".."
        ) ||
        path.posix.isAbsolute(filePath) ||
        /^[A-Za-z]:\//u.test(filePath)
    ) {
        return false;
    }
    const role = sourceRole(filePath);
    return (
        !isTestPath(filePath) &&
        (role === "browser" || role === "contracts" || role === "shared")
    );
}

/**
 * Removes Vitest/V8's exact zero-valued anonymous-script sentinel and validates every
 * remaining source against the Storybook production authority.
 * @param lcov One private Vitest LCOV document before aggregate merging.
 * @returns Canonical LCOV containing only validated production records.
 */
export function normalizeStorybookProductionCoverage(lcov: string): string {
    const validRecords: string[] = [];
    const invalidSources: string[] = [];
    for (const rawRecord of lcov.split("end_of_record")) {
        const lines = rawRecord
            .split(/\r?\n/u)
            .map((line) => line.trimEnd())
            .filter((line) => line.length > 0);
        if (lines.length === 0) continue;

        const sourceLines = lines.filter((line) => line.startsWith("SF:"));
        if (sourceLines.length !== 1) {
            throw new Error("Storybook coverage contains a malformed source record");
        }
        const sourcePath = normalizeStorybookCoverageSource(
            (sourceLines[0] as string).slice(3)
        );
        if (sourcePath.length === 0 && isEmptyV8CoverageRecord(lines)) continue;
        if (!validateStorybookCoverageSource(sourcePath)) {
            invalidSources.push(sourcePath);
            continue;
        }
        validRecords.push(`${lines.join("\n")}\nend_of_record`);
    }

    if (invalidSources.length > 0) {
        throw new Error(
            `Storybook coverage contains non-production source records:\n${[
                ...new Set(invalidSources),
            ]
                .toSorted()
                .join("\n")}`
        );
    }
    if (validRecords.length === 0) {
        throw new Error("Storybook coverage contains no production source records");
    }
    return `${validRecords.join("\n")}\n`;
}

/**
 * Rejects Storybook LCOV records for stories, tests, support, or non-repository code.
 * @param lcov One private Vitest LCOV document before aggregate merging.
 */
export function assertStorybookProductionCoverageSources(lcov: string): void {
    normalizeStorybookProductionCoverage(lcov);
}

async function validateStorybookCoverageReport(
    reportPath: string,
    privateCoverageRoot: string
): Promise<void> {
    const { text } = await readBoundedUtf8RegularFile(
        reportPath,
        privateCoverageRoot,
        maximumPrivateLcovBytes,
        "Storybook coverage artifact is unavailable or invalid",
        "Storybook coverage artifact is not valid UTF-8"
    );
    const normalizedCoverage = normalizeStorybookProductionCoverage(text);
    await writeFile(reportPath, normalizedCoverage, {
        encoding: "utf8",
        mode: 0o600,
    });
}

async function resetCoverageDirectory(directory: string): Promise<void> {
    await rm(directory, { force: true, recursive: true });
    await mkdir(directory, { mode: 0o700, recursive: true });
}

async function listCoverageArtifacts(directory: string): Promise<readonly string[]> {
    const artifactPaths: string[] = [];

    async function visit(currentDirectory: string): Promise<void> {
        const directoryEntries = await readdir(currentDirectory, {
            withFileTypes: true,
        });
        const entries = directoryEntries.toSorted((left, right) =>
            left.name.localeCompare(right.name)
        );
        for (const entry of entries) {
            const entryPath = path.join(currentDirectory, entry.name);
            if (entry.isDirectory()) {
                await visit(entryPath);
                continue;
            }
            if (entry.name !== "lcov.info") continue;
            if (!entry.isFile()) {
                throw new Error(
                    `Coverage artifact inventory contains a non-regular LCOV entry: ${normalizeCoverageArtifactPath(directory, entryPath)}`
                );
            }
            artifactPaths.push(entryPath);
        }
    }

    await visit(directory);
    return Object.freeze(artifactPaths);
}

async function mergeCoverageReports(
    reportPaths: readonly string[],
    reportPattern: string
): Promise<string> {
    const merged = await mergeCoverageReportFiles([...reportPaths], {
        pattern: reportPattern,
    });
    return normalizeMergedLineCoverage(merged);
}

/**
 * Keeps the aggregate aligned with the line-coverage gate shared by every runtime.
 * Bun emits line/function LCOV while Vitest also emits branch records. Retaining only
 * Vitest's branch records makes Codecov downgrade otherwise-hit Bun lines to partial
 * or missing coverage, so a mixed aggregate must not claim comparable branch data.
 * @param coverage Merged LCOV containing reports from every runtime partition.
 * @returns LCOV containing only the line and function metrics every runtime emits.
 */
export function normalizeMergedLineCoverage(coverage: string): string {
    return coverage
        .split("\n")
        .filter((line) => !/^(?:BRDA|BRF|BRH):/u.test(line))
        .join("\n");
}

async function writeCoverageReport(filePath: string, coverage: string): Promise<void> {
    await writeFile(filePath, `${coverage}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
}

const defaultDependencies: CoverageRunnerDependencies = Object.freeze({
    checkReport: checkCoverageFile,
    coverageDirectory,
    listArtifacts: listCoverageArtifacts,
    loadTests: loadCoverageTestInventories,
    log: (message: string) => console.log(message),
    mergeReports: mergeCoverageReports,
    projectRoot,
    resetDirectory: resetCoverageDirectory,
    runCommand: runTestProcess,
    validateStorybookReport: validateStorybookCoverageReport,
    writeReport: writeCoverageReport,
});

async function assertCoveragePlanArtifacts(
    dependencies: CoverageRunnerDependencies,
    plans: readonly CoveragePartitionPlan[]
): Promise<void> {
    assertExactCoverageArtifactInventory(
        dependencies.coverageDirectory,
        plans.map(({ reportPath }) => reportPath),
        await dependencies.listArtifacts(dependencies.coverageDirectory)
    );
}

async function runCoveragePlans(
    dependencies: CoverageRunnerDependencies,
    plans: readonly CoveragePartitionPlan[]
): Promise<number> {
    return runSequentialTestBatches(plans, async (plan) => {
        const exitCode = await dependencies.runCommand(
            createCoverageTestCommand(dependencies.projectRoot, plan),
            dependencies.projectRoot
        );
        if (exitCode !== 0) return exitCode;
        if (plan.partition === "storybook") {
            await dependencies.validateStorybookReport(
                plan.reportPath,
                dependencies.coverageDirectory
            );
        }
        return 0;
    });
}

async function mergeAndCheckCoverage(
    dependencies: CoverageRunnerDependencies,
    plans: readonly CoveragePartitionPlan[]
): Promise<void> {
    const mergedCoverage = await dependencies.mergeReports(
        plans.map((plan) => plan.reportPath),
        path.join(dependencies.coverageDirectory, "*", "lcov.info")
    );
    const lcovPath = path.join(dependencies.coverageDirectory, "lcov.info");
    await dependencies.writeReport(lcovPath, mergedCoverage);

    const summary = await dependencies.checkReport(
        lcovPath,
        requiredLineCoveragePercent,
        coveredSourceRoots,
        dependencies.projectRoot
    );
    dependencies.log(
        `Coverage ${summary.percent.toFixed(2)}% meets required ${requiredLineCoveragePercent.toFixed(2)}% (${summary.hitLines}/${summary.foundLines} lines)`
    );
}

/**
 * Parses the intentionally narrow CLI used by package scripts and CI.
 * @param arguments_ Arguments after the executable and script path.
 * @returns Default complete gate, one partition, or merge-only mode.
 */
export function parseCoverageRunMode(arguments_: readonly string[]): CoverageRunMode {
    if (arguments_.length === 0) return "all";
    if (arguments_.length === 1 && arguments_[0] === "--merge") return "merge";
    if (arguments_.length === 1) {
        const match = /^--partition=(browser|bun|storybook)$/u.exec(
            arguments_[0] as string
        );
        if (match !== null) return match[1] as CoveragePartition;
    }
    throw new TypeError(
        "Coverage arguments must be empty, --merge, or --partition=browser|bun|storybook"
    );
}

/**
 * Runs the complete local gate, one CI partition, or the fail-closed CI merge.
 * @param dependencies Injectable process, filesystem, merge, and policy boundaries.
 * @param mode No-argument local gate, one exact CI partition, or merge-only mode.
 * @returns Zero when every test, output policy, and line threshold passes.
 */
export async function runCoverage(
    dependencies: CoverageRunnerDependencies = defaultDependencies,
    mode: CoverageRunMode = "all"
): Promise<number> {
    if (mode !== "merge") {
        await dependencies.resetDirectory(dependencies.coverageDirectory);
    }
    const inventories = await dependencies.loadTests(dependencies.projectRoot);
    const plans = createCoveragePartitionPlan(
        dependencies.coverageDirectory,
        inventories
    );

    if (mode === "merge") {
        await assertCoveragePlanArtifacts(dependencies, plans);
        for (const plan of selectCoveragePartitionPlans(plans, "storybook")) {
            await dependencies.validateStorybookReport(
                plan.reportPath,
                dependencies.coverageDirectory
            );
        }
        await mergeAndCheckCoverage(dependencies, plans);
        return 0;
    }

    const selectedPlans =
        mode === "all" ? plans : selectCoveragePartitionPlans(plans, mode);
    const testExitCode = await runCoveragePlans(dependencies, selectedPlans);
    if (testExitCode !== 0) return testExitCode;
    await assertCoveragePlanArtifacts(dependencies, selectedPlans);

    if (mode === "all") {
        await mergeAndCheckCoverage(dependencies, plans);
    }
    return 0;
}

if (import.meta.main) {
    process.exitCode = await runCoverage(
        defaultDependencies,
        parseCoverageRunMode(process.argv.slice(2))
    );
}
