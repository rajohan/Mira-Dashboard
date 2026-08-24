import path from "node:path";

import { discoverSourceFiles } from "./sourceBoundaries/sourceDiscovery.ts";

/** Repository-owned count of duration-balanced batches per test partition. */
export const testBatchCount = 3;

/** Repository-owned worker count for every isolated test child. */
export const testWorkerCount = 3;

/** Repository-owned versioned per-file scheduling inventory. */
export interface TestTimingsInventory {
    readonly files: Readonly<Record<string, number>>;
    readonly version: 1;
}

/** One discovered test and its recorded scheduling duration. */
export interface TimedTestFile {
    readonly durationMs: number;
    readonly filePath: string;
}

/** One duration-balanced batch executed by fresh workers. */
export interface TimedTestBatch {
    readonly durationMs: number;
    readonly testFiles: readonly string[];
}

/** One named batch in deterministic execution order. */
export interface TimedTestBatchPlan extends TimedTestBatch {
    readonly name: string;
}

/** Policy used to select one exact test inventory from discovered sources. */
export interface TestInventoryPolicy {
    readonly inventoryName: string;
    readonly isTestFile: (filePath: string) => boolean;
}

/** Duration-balanced batch-planning policy. */
export interface TestBatchPolicy {
    readonly batchCount: number;
    readonly inventoryName: string;
    readonly namePrefix: string;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function comparePaths(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function repeatedPaths(paths: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const filePath of paths) {
        if (seen.has(filePath)) duplicates.add(filePath);
        seen.add(filePath);
    }
    return [...duplicates].toSorted(comparePaths);
}

function exactInventoryError(
    expectedPaths: readonly string[],
    actualPaths: readonly string[],
    inventoryName: string
): Error | undefined {
    const duplicateExpectedPaths = repeatedPaths(expectedPaths);
    const duplicateActualPaths = repeatedPaths(actualPaths);
    const expected = new Set(expectedPaths);
    const actual = new Set(actualPaths);
    const missingPaths = [...expected].filter((filePath) => !actual.has(filePath));
    const unexpectedPaths = [...actual].filter((filePath) => !expected.has(filePath));
    const findings = [
        ...(duplicateExpectedPaths.length === 0
            ? []
            : [`duplicate discovered files:\n${duplicateExpectedPaths.join("\n")}`]),
        ...(duplicateActualPaths.length === 0
            ? []
            : [`duplicate ${inventoryName} files:\n${duplicateActualPaths.join("\n")}`]),
        ...(missingPaths.length === 0
            ? []
            : [
                  `files missing from ${inventoryName}:\n${missingPaths.toSorted(comparePaths).join("\n")}`,
              ]),
        ...(unexpectedPaths.length === 0
            ? []
            : [
                  `unexpected ${inventoryName} files:\n${unexpectedPaths.toSorted(comparePaths).join("\n")}`,
              ]),
    ];
    if (findings.length === 0) return undefined;
    return new Error(`${inventoryName} mismatch:\n${findings.join("\n")}`);
}

/**
 * Validates one measured millisecond duration and gives sub-millisecond successes
 * the smallest positive scheduling weight.
 * @param duration Candidate measured duration rounded to milliseconds.
 * @param invalidDurationMessage Exact diagnostic for malformed measurements.
 * @returns A positive safe-integer scheduling weight.
 */
export function normalizeMeasuredTestDuration(
    duration: unknown,
    invalidDurationMessage: string
): number {
    if (typeof duration !== "number" || !Number.isSafeInteger(duration) || duration < 0) {
        throw new TypeError(invalidDurationMessage);
    }
    return Math.max(1, duration);
}

function normalizeTimedTestFile(
    testFile: TimedTestFile,
    inventoryName: string
): TimedTestFile {
    if (testFile.filePath.length === 0) {
        throw new TypeError(`${inventoryName} contains an empty test path`);
    }
    return Object.freeze({
        durationMs: normalizeMeasuredTestDuration(
            testFile.durationMs,
            `Invalid ${inventoryName} timing duration: ${testFile.filePath}`
        ),
        filePath: testFile.filePath,
    });
}

/**
 * Parses one versioned file-duration scheduling inventory.
 * @param value Candidate decoded timing document.
 * @returns The validated version-one inventory.
 */
export function parseTestTimingsInventory(value: unknown): TestTimingsInventory {
    if (!isUnknownRecord(value)) {
        throw new TypeError("Test timings must be an object");
    }
    const { files: rawFiles, version } = value;
    if (version !== 1 || !isUnknownRecord(rawFiles)) {
        throw new TypeError("Test timings must contain version 1 and a file map");
    }

    const entries: [string, number][] = [];
    for (const [filePath, duration] of Object.entries(rawFiles)) {
        if (filePath.length === 0) {
            throw new TypeError(`Invalid test timing duration: ${filePath}`);
        }
        entries.push([
            filePath,
            normalizeMeasuredTestDuration(
                duration,
                `Invalid test timing duration: ${filePath}`
            ),
        ]);
    }
    return Object.freeze({
        files: Object.freeze(Object.fromEntries(entries)),
        version,
    });
}

/**
 * Loads and validates one repository test-timing inventory in Bun or Node.
 * @param timingsPath Absolute or repository-relative timing inventory path.
 * @param projectRoot Root used to resolve repository-relative inventory paths.
 * @returns The validated timing inventory.
 */
export async function readTestTimingsInventory(
    timingsPath: string,
    projectRoot: string
): Promise<TestTimingsInventory> {
    const resolvedTimingsPath = path.resolve(projectRoot, timingsPath);
    const rawInventory: unknown = await Bun.file(resolvedTimingsPath).json();
    return parseTestTimingsInventory(rawInventory);
}

/**
 * Discovers reviewed source files and fails closed on repository-layout findings.
 * @param projectRoot Repository root to inspect.
 * @param inventoryName Human-readable inventory identity for errors.
 * @returns Every reviewed source path in deterministic order.
 */
export async function discoverReviewedSourceFiles(
    projectRoot: string,
    inventoryName: string
): Promise<readonly string[]> {
    const discovery = await discoverSourceFiles(projectRoot);
    if (discovery.violations.length > 0) {
        throw new Error(
            `${inventoryName} requires valid source discovery:\n${discovery.violations
                .map(
                    (violation) =>
                        `${violation.importer}:${violation.line}: ${violation.message}`
                )
                .join("\n")}`
        );
    }
    return Object.freeze([...discovery.files]);
}

/**
 * Matches actual runnable tests to an exact timing inventory.
 * @param discoveredSourceFiles Files proven by source discovery.
 * @param timings Validated timing inventory.
 * @param policy Test selection and diagnostic identity.
 * @returns Every selected test with its scheduling duration.
 */
export function createExactTimedTestInventory(
    discoveredSourceFiles: readonly string[],
    timings: TestTimingsInventory,
    policy: TestInventoryPolicy
): readonly TimedTestFile[] {
    const discoveredTests = discoveredSourceFiles.filter((filePath) =>
        policy.isTestFile(filePath)
    );
    if (discoveredTests.length === 0) {
        throw new Error(
            `${policy.inventoryName} source discovery found no runnable tests`
        );
    }
    const inventoryError = exactInventoryError(
        discoveredTests,
        Object.keys(timings.files),
        policy.inventoryName
    );
    if (inventoryError !== undefined) throw inventoryError;

    return Object.freeze(
        discoveredTests.toSorted(comparePaths).map((filePath) =>
            Object.freeze({
                durationMs: normalizeMeasuredTestDuration(
                    timings.files[filePath],
                    `Invalid ${policy.inventoryName} timing duration: ${filePath}`
                ),
                filePath,
            })
        )
    );
}

/**
 * Builds an update inventory while giving newly discovered tests a deterministic weight.
 * Stale timing entries remain untouched until every update batch passes.
 * @param discoveredSourceFiles Files proven by source discovery.
 * @param timings Existing validated timing inventory.
 * @param policy Test selection and diagnostic identity.
 * @returns Every actual test with an existing or provisional duration.
 */
export function createTimingUpdateTestInventory(
    discoveredSourceFiles: readonly string[],
    timings: TestTimingsInventory,
    policy: TestInventoryPolicy
): readonly TimedTestFile[] {
    const discoveredTests = discoveredSourceFiles.filter((filePath) =>
        policy.isTestFile(filePath)
    );
    if (discoveredTests.length === 0) {
        throw new Error(
            `${policy.inventoryName} source discovery found no runnable tests`
        );
    }
    const duplicateTests = repeatedPaths(discoveredTests);
    if (duplicateTests.length > 0) {
        throw new Error(
            `${policy.inventoryName} mismatch:\nduplicate discovered files:\n${duplicateTests.join("\n")}`
        );
    }
    const existingDurations = Object.entries(timings.files).map(([filePath, duration]) =>
        normalizeMeasuredTestDuration(
            duration,
            `Invalid ${policy.inventoryName} timing duration: ${filePath}`
        )
    );
    const provisionalDurationMs = Math.max(1, ...existingDurations);
    return Object.freeze(
        discoveredTests.toSorted(comparePaths).map((filePath) =>
            Object.freeze({
                durationMs: normalizeMeasuredTestDuration(
                    timings.files[filePath] ?? provisionalDurationMs,
                    `Invalid ${policy.inventoryName} timing duration: ${filePath}`
                ),
                filePath,
            })
        )
    );
}

/**
 * Proves that candidate batches contain the expected inventory exactly once.
 * @param expectedTests Timed tests expected by the gate.
 * @param batches Candidate sequential batches.
 * @param partitionName Human-readable partition identity for errors.
 */
export function assertExactTimedTestPartition(
    expectedTests: readonly TimedTestFile[],
    batches: readonly TimedTestBatch[],
    partitionName: string
): void {
    const inventoryError = exactInventoryError(
        expectedTests.map(({ filePath }) => filePath),
        batches.flatMap(({ testFiles }) => testFiles),
        partitionName
    );
    if (inventoryError !== undefined) throw inventoryError;
}

/**
 * Allocates tests longest-first across deterministic, count-capped duration bins.
 * @param tests Exact timed test inventory.
 * @param policy Batch count, identity, and stable name prefix.
 * @returns Named nonempty batches in execution order.
 */
export function createTimedTestBatchPlan(
    tests: readonly TimedTestFile[],
    policy: TestBatchPolicy
): readonly TimedTestBatchPlan[] {
    if (!Number.isSafeInteger(policy.batchCount) || policy.batchCount < 1) {
        throw new TypeError(`${policy.inventoryName} batch count must be positive`);
    }
    if (tests.length < policy.batchCount) {
        throw new Error(
            `${policy.inventoryName} requires at least ${policy.batchCount} test files`
        );
    }
    const duplicateTests = repeatedPaths(tests.map(({ filePath }) => filePath));
    if (duplicateTests.length > 0) {
        throw new Error(
            `${policy.inventoryName} contains duplicate timed files:\n${duplicateTests.join("\n")}`
        );
    }
    const normalizedTests = tests.map((testFile) =>
        normalizeTimedTestFile(testFile, policy.inventoryName)
    );

    const mutableBatches = Array.from({ length: policy.batchCount }, () => ({
        durationMs: 0,
        testFiles: [] as string[],
    }));
    const maximumBatchFiles = Math.ceil(tests.length / policy.batchCount);
    const longestFirst = normalizedTests.toSorted(
        (left, right) =>
            right.durationMs - left.durationMs ||
            comparePaths(left.filePath, right.filePath)
    );
    for (const testFile of longestFirst) {
        const candidates = mutableBatches.filter(
            ({ testFiles }) => testFiles.length < maximumBatchFiles
        );
        let target = candidates[0] as (typeof mutableBatches)[number];
        for (const candidate of candidates.slice(1)) {
            if (
                candidate.durationMs < target.durationMs ||
                (candidate.durationMs === target.durationMs &&
                    candidate.testFiles.length < target.testFiles.length)
            ) {
                target = candidate;
            }
        }
        const nextDurationMs = target.durationMs + testFile.durationMs;
        if (!Number.isSafeInteger(nextDurationMs)) {
            throw new TypeError(
                `${policy.inventoryName} timing total exceeds safe integer range`
            );
        }
        target.testFiles.push(testFile.filePath);
        target.durationMs = nextDurationMs;
    }

    const plans = Object.freeze(
        mutableBatches.map(({ durationMs, testFiles }, index) =>
            Object.freeze({
                durationMs,
                name: `${policy.namePrefix}-${String(index + 1).padStart(3, "0")}`,
                testFiles: Object.freeze(testFiles),
            })
        )
    );
    assertExactTimedTestPartition(tests, plans, `${policy.inventoryName} partition`);
    return plans;
}

/**
 * Runs named batches sequentially and stops at the first nonzero child result.
 * @param batches Complete deterministic execution plan.
 * @param runBatch Side-effect boundary for one fresh-worker child.
 * @returns Zero after every batch passes, otherwise the first failure code.
 */
export async function runSequentialTestBatches<TBatch extends TimedTestBatchPlan>(
    batches: readonly TBatch[],
    runBatch: (batch: TBatch) => Promise<number>
): Promise<number> {
    for (const batch of batches) {
        const exitCode = await runBatch(batch);
        if (exitCode !== 0) return exitCode;
    }
    return 0;
}
