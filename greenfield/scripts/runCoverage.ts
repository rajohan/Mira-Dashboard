import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { mergeCoverageReportFiles } from "lcov-result-merger";

import { checkCoverageFile, requiredLineCoveragePercent } from "./checkCoverage.ts";
import { runTestSuite } from "./runTestSuite.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const coverageDirectory = path.join(projectRoot, "coverage");
const lcovPath = path.join(coverageDirectory, "lcov.info");
const coveredSourceRoots = Object.freeze(["src"]);

export type CoveragePartition = "browser" | "bun";

const coveragePartitions = Object.freeze([
    Object.freeze({ name: "bun", outputDirectoryName: "bun" }),
    Object.freeze({ name: "browser", outputDirectoryName: "browser" }),
] satisfies readonly Readonly<{
    name: CoveragePartition;
    outputDirectoryName: string;
}>[]);

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
    if (partition === "browser") {
        return Object.freeze([
            ...coverageArguments,
            "--preload",
            "./src/browser/test/setup.ts",
            "src/browser",
        ]);
    }
    return Object.freeze([
        ...coverageArguments,
        "--path-ignore-patterns",
        "src/browser/**",
        "scripts",
        "src",
    ]);
}

/** @returns Completion after coverage output has one fresh private directory. */
async function resetCoverageDirectory(): Promise<void> {
    await rm(coverageDirectory, { force: true, recursive: true });
    await mkdir(coverageDirectory, { mode: 0o700, recursive: true });
}

/**
 * Runs the complete test set with LCOV and enforces the repository threshold.
 * @returns Zero when tests, output policy, and line coverage all pass.
 */
export async function runCoverage(): Promise<number> {
    await resetCoverageDirectory();

    const partitionReports: string[] = [];
    for (const partition of coveragePartitions) {
        const outputDirectory = path.join(
            coverageDirectory,
            partition.outputDirectoryName
        );
        const testExitCode = await runTestSuite(
            createCoverageTestArguments(outputDirectory, partition.name),
            projectRoot
        );
        if (testExitCode !== 0) return testExitCode;
        partitionReports.push(path.join(outputDirectory, "lcov.info"));
    }

    const mergedCoverage = await mergeCoverageReportFiles(partitionReports, {
        pattern: "",
    });
    await writeFile(lcovPath, `${mergedCoverage}\n`, {
        encoding: "utf8",
        mode: 0o600,
    });

    const summary = await checkCoverageFile(
        lcovPath,
        requiredLineCoveragePercent,
        coveredSourceRoots,
        projectRoot
    );
    console.log(
        `Coverage ${summary.percent.toFixed(2)}% meets required ${requiredLineCoveragePercent.toFixed(2)}% (${summary.hitLines}/${summary.foundLines} lines)`
    );
    return 0;
}

if (import.meta.main) process.exitCode = await runCoverage();
