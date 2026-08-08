import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { mergeCoverageReportFiles } from "lcov-result-merger";

import {
    checkCoverageFile,
    type LineCoverageSummary,
    requiredLineCoveragePercent,
} from "./checkCoverage.ts";
import { createBrowserTestArguments } from "./runBrowserTests.ts";
import { runTestSuite } from "./runTestSuite.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const coverageDirectory = path.join(projectRoot, "coverage");
const coveredSourceRoots = Object.freeze(["src"]);

/** Independently executed test process contributing to the merged LCOV artifact. */
export type CoveragePartition =
    | "browser-core"
    | "browser-jobs"
    | "browser-schedule-detail-form"
    | "browser-schedule-detail-state"
    | "bun";

/** One isolated coverage process and its private artifact paths. */
export interface CoveragePartitionPlan {
    readonly name: CoveragePartition;
    readonly outputDirectory: string;
    readonly reportPath: string;
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
    readonly log: (message: string) => void;
    readonly mergeReports: (reportPaths: readonly string[]) => Promise<string>;
    readonly projectRoot: string;
    readonly resetDirectory: (directory: string) => Promise<void>;
    readonly runTests: (
        arguments_: readonly string[],
        projectRoot: string
    ) => Promise<number>;
    readonly writeReport: (filePath: string, coverage: string) => Promise<void>;
}

/**
 * Creates the deterministic coverage process and merge inventory.
 * @param directory Root directory for private and merged LCOV artifacts.
 * @returns Five process plans in execution and merge order.
 */
export function createCoveragePartitionPlan(
    directory: string
): readonly CoveragePartitionPlan[] {
    return Object.freeze(
        (
            [
                "bun",
                "browser-core",
                "browser-jobs",
                "browser-schedule-detail-form",
                "browser-schedule-detail-state",
            ] as const
        ).map((name) => {
            const outputDirectory = path.join(directory, name);
            return Object.freeze({
                name,
                outputDirectory,
                reportPath: path.join(outputDirectory, "lcov.info"),
            });
        })
    );
}

/**
 * Builds the exact Bun test arguments used by the coverage gate.
 * @param outputDirectory Directory where Bun writes coverage artifacts.
 * @param partition Runtime partition whose tests and preload policy are selected.
 * @returns Complete arguments after `bun test`.
 */
export function createCoverageTestArguments(
    outputDirectory: string,
    partition: CoveragePartition
): readonly string[] {
    const coverageArguments = [
        "--coverage",
        "--coverage-reporter",
        "lcov",
        "--coverage-dir",
        outputDirectory,
    ];
    if (partition === "browser-core") {
        return createBrowserTestArguments("core", coverageArguments);
    }
    if (partition === "browser-jobs") {
        return createBrowserTestArguments("jobs", coverageArguments);
    }
    if (partition === "browser-schedule-detail-form") {
        return createBrowserTestArguments("schedule-detail-form", coverageArguments);
    }
    if (partition === "browser-schedule-detail-state") {
        return createBrowserTestArguments("schedule-detail-state", coverageArguments);
    }
    return Object.freeze([
        ...coverageArguments,
        "scripts",
        "src/app",
        "src/contracts",
        "src/server",
        "src/shared",
        "src/test",
        "src/worker",
    ]);
}

/**
 * Recreates the private coverage root.
 * @param directory Coverage root to recreate.
 * @returns Completion after coverage output has one fresh private directory.
 */
async function resetCoverageDirectory(directory: string): Promise<void> {
    await rm(directory, { force: true, recursive: true });
    await mkdir(directory, { mode: 0o700, recursive: true });
}

/**
 * Merges the exact private LCOV reports without filesystem discovery.
 * @param reportPaths Private LCOV paths in deterministic partition order.
 * @returns One merged LCOV document.
 */
async function mergeCoverageReports(reportPaths: readonly string[]): Promise<string> {
    return mergeCoverageReportFiles([...reportPaths], { pattern: "" });
}

/**
 * Writes the final merged LCOV document with a stable trailing newline.
 * @param filePath Final LCOV artifact path.
 * @param coverage Merged LCOV document.
 */
async function writeCoverageReport(filePath: string, coverage: string): Promise<void> {
    await writeFile(filePath, `${coverage}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });
}

const defaultDependencies: CoverageRunnerDependencies = Object.freeze({
    checkReport: checkCoverageFile,
    coverageDirectory,
    log: (message: string) => console.log(message),
    mergeReports: mergeCoverageReports,
    projectRoot,
    resetDirectory: resetCoverageDirectory,
    runTests: runTestSuite,
    writeReport: writeCoverageReport,
});

/**
 * Runs the complete test set with LCOV and enforces the repository threshold.
 * @param dependencies Injectable process, filesystem, merge, and policy boundaries.
 * @returns Zero when tests, output policy, and line coverage all pass.
 */
export async function runCoverage(
    dependencies: CoverageRunnerDependencies = defaultDependencies
): Promise<number> {
    await dependencies.resetDirectory(dependencies.coverageDirectory);

    const plans = createCoveragePartitionPlan(dependencies.coverageDirectory);
    for (const plan of plans) {
        const testExitCode = await dependencies.runTests(
            createCoverageTestArguments(plan.outputDirectory, plan.name),
            dependencies.projectRoot
        );
        if (testExitCode !== 0) return testExitCode;
    }

    const mergedCoverage = await dependencies.mergeReports(
        plans.map((plan) => plan.reportPath)
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
    return 0;
}

if (import.meta.main) process.exitCode = await runCoverage();
