import path from "node:path";

import { runTestSuite } from "./runTestSuite.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const browserTestPreload = "./src/browser/test/setup.ts";
const browserJobsRoot = "src/browser/jobs";
const browserTestGlobs = Object.freeze([
    "src/browser/**/*.test.ts",
    "src/browser/**/*.test.tsx",
] as const);
const isolatedJobTestDefinitions = Object.freeze([
    Object.freeze({
        name: "schedule-detail-form",
        testRoot: `${browserJobsRoot}/ScheduleDetailForm.test.tsx`,
    }),
    Object.freeze({
        name: "schedule-detail-state-disable",
        testRoot: `${browserJobsRoot}/ScheduleDetailStateDisable.test.tsx`,
    }),
    Object.freeze({
        name: "schedule-detail-state-errors",
        testRoot: `${browserJobsRoot}/ScheduleDetailStateErrors.test.tsx`,
    }),
    Object.freeze({
        name: "schedule-detail-state-version",
        testRoot: `${browserJobsRoot}/ScheduleDetailStateVersion.test.tsx`,
    }),
    Object.freeze({
        name: "schedule-detail-state-copy",
        testRoot: `${browserJobsRoot}/ScheduleDetailStateCopy.test.tsx`,
    }),
    Object.freeze({
        name: "schedule-detail-state-replay",
        testRoot: `${browserJobsRoot}/ScheduleDetailStateReplay.test.tsx`,
    }),
] as const);
const isolatedJobTestPaths: readonly string[] = Object.freeze(
    isolatedJobTestDefinitions.map((definition) => definition.testRoot)
);

/** Independently executed browser-test process. */
export type BrowserTestPartition =
    | "core"
    | "jobs"
    | (typeof isolatedJobTestDefinitions)[number]["name"];

/** Browser-test process metadata in deterministic execution order. */
export const browserTestPartitions = Object.freeze([
    Object.freeze({ name: "core", testRoot: "src/browser" }),
    Object.freeze({ name: "jobs", testRoot: browserJobsRoot }),
    ...isolatedJobTestDefinitions,
] satisfies readonly Readonly<{
    name: BrowserTestPartition;
    testRoot: string;
}>[]);

/** Injectable process boundary used by the browser shard orchestrator. */
export interface BrowserTestRunnerDependencies {
    readonly discoverTests: (projectRoot: string) => BrowserTestInventory;
    readonly projectRoot: string;
    readonly runTests: (
        arguments_: readonly string[],
        projectRoot: string
    ) => Promise<number>;
}

const defaultDependencies: BrowserTestRunnerDependencies = Object.freeze({
    discoverTests: discoverBrowserTestInventory,
    projectRoot,
    runTests: runTestSuite,
});

/** One immutable browser-test inventory discovered before any child process starts. */
export interface BrowserTestInventory {
    readonly projectRoot: string;
    readonly testPaths: readonly string[];
}

function normalizeBrowserTestPath(filePath: string): string | undefined {
    const normalizedPath = filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
    if (
        normalizedPath.includes("\0") ||
        path.posix.isAbsolute(normalizedPath) ||
        path.posix.normalize(normalizedPath) !== normalizedPath
    ) {
        return undefined;
    }
    if (!normalizedPath.startsWith("src/browser/")) return undefined;
    return /\.test\.tsx?$/u.test(normalizedPath) ? normalizedPath : undefined;
}

/**
 * Determines whether one browser process owns an exact repository test path.
 * @param partition Browser-test process whose selection is evaluated.
 * @param filePath Repository-relative candidate test path.
 * @returns True only when the path belongs to that process.
 */
export function browserTestPartitionOwnsPath(
    partition: BrowserTestPartition,
    filePath: string
): boolean {
    const normalizedPath = normalizeBrowserTestPath(filePath);
    if (normalizedPath === undefined) return false;
    const partitionDefinition = browserTestPartitions.find(
        (candidate) => candidate.name === partition
    );
    if (partitionDefinition === undefined) return false;
    if (partition !== "core" && partition !== "jobs") {
        return normalizedPath === partitionDefinition.testRoot;
    }
    if (partition === "jobs") {
        return (
            normalizedPath.startsWith(`${browserJobsRoot}/`) &&
            !isolatedJobTestPaths.includes(normalizedPath)
        );
    }
    return !normalizedPath.startsWith(`${browserJobsRoot}/`);
}

/**
 * Identifies the one browser-test process that owns a repository-relative path.
 * @param filePath Repository-relative browser test path.
 * @returns The owning partition, or undefined for paths outside the browser tests.
 */
export function browserTestPartitionForPath(
    filePath: string
): BrowserTestPartition | undefined {
    return browserTestPartitions.find((partition) =>
        browserTestPartitionOwnsPath(partition.name, filePath)
    )?.name;
}

/**
 * Validates and freezes one repository-relative browser-test inventory.
 * @param inventoryProjectRoot Repository root used to resolve exact Bun paths.
 * @param filePaths Discovered repository-relative browser test paths.
 * @returns Sorted, uniquely owned paths bound to the supplied root.
 */
export function createBrowserTestInventory(
    inventoryProjectRoot: string,
    filePaths: Iterable<string>
): BrowserTestInventory {
    const normalizedPaths = [...filePaths].map((filePath) => {
        const normalizedPath = normalizeBrowserTestPath(filePath);
        if (normalizedPath === undefined) {
            throw new TypeError(`Invalid discovered browser-test path: ${filePath}`);
        }
        return normalizedPath;
    });
    const uniquePaths = new Set(normalizedPaths);
    if (uniquePaths.size !== normalizedPaths.length) {
        throw new TypeError("Browser-test discovery returned duplicate paths");
    }

    const discoveredPaths = [...uniquePaths].toSorted();
    for (const filePath of discoveredPaths) {
        const ownerCount = browserTestPartitions.filter((partition) =>
            browserTestPartitionOwnsPath(partition.name, filePath)
        ).length;
        if (ownerCount !== 1) {
            throw new TypeError(
                `Discovered browser test must have exactly one owner: ${filePath}`
            );
        }
    }
    for (const partition of browserTestPartitions) {
        if (
            !discoveredPaths.some((filePath) =>
                browserTestPartitionOwnsPath(partition.name, filePath)
            )
        ) {
            throw new TypeError(
                `Browser-test partition has no discovered files: ${partition.name}`
            );
        }
    }
    return Object.freeze({
        projectRoot: path.resolve(inventoryProjectRoot),
        testPaths: Object.freeze(discoveredPaths),
    });
}

/**
 * Discovers one stable browser-test inventory from an injected repository root.
 * @param inventoryProjectRoot Repository root to scan.
 * @returns Validated inventory reused by every browser shard.
 */
export function discoverBrowserTestInventory(
    inventoryProjectRoot: string
): BrowserTestInventory {
    const discoveredPaths = browserTestGlobs.flatMap((pattern) => [
        ...new Bun.Glob(pattern).scanSync({
            cwd: inventoryProjectRoot,
            onlyFiles: true,
        }),
    ]);
    return createBrowserTestInventory(inventoryProjectRoot, discoveredPaths);
}

/**
 * Builds the exact Bun test arguments for one isolated browser process.
 * @param partition Browser-test process to execute.
 * @param inventory Stable exact-path inventory shared across every process.
 * @param leadingArguments Optional Bun test flags placed before shared browser flags.
 * @returns Complete arguments after `bun test`.
 */
export function createBrowserTestArguments(
    partition: BrowserTestPartition,
    inventory: BrowserTestInventory,
    leadingArguments: readonly string[] = []
): readonly string[] {
    const partitionDefinition = browserTestPartitions.find(
        (candidate) => candidate.name === partition
    );
    if (partitionDefinition === undefined) {
        throw new TypeError(`Unknown browser-test partition: ${partition as string}`);
    }

    const arguments_ = [
        ...leadingArguments,
        "--preload",
        browserTestPreload,
        "--max-concurrency=1",
        "--bail=1",
    ];
    const partitionTestPaths = inventory.testPaths.filter((filePath) =>
        browserTestPartitionOwnsPath(partition, filePath)
    );
    if (partitionTestPaths.length === 0) {
        throw new TypeError(
            `Browser-test partition has no discovered files: ${partition}`
        );
    }
    arguments_.push(
        ...partitionTestPaths.map((filePath) =>
            path.resolve(inventory.projectRoot, filePath)
        )
    );
    return Object.freeze(arguments_);
}

/**
 * Runs all browser partitions in fresh, sequential, fail-fast Bun processes.
 * @param dependencies Injectable process runner and repository root.
 * @returns The first failing exit code, or zero after every partition passes.
 */
export async function runBrowserTestShards(
    dependencies: BrowserTestRunnerDependencies = defaultDependencies
): Promise<number> {
    const inventory = dependencies.discoverTests(dependencies.projectRoot);
    for (const partition of browserTestPartitions) {
        const exitCode = await dependencies.runTests(
            createBrowserTestArguments(partition.name, inventory),
            dependencies.projectRoot
        );
        if (exitCode !== 0) return exitCode;
    }
    return 0;
}

if (import.meta.main) process.exitCode = await runBrowserTestShards();
