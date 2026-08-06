import { mkdir, unlink } from "node:fs/promises";
import path from "node:path";

import { checkCoverageFile, requiredLineCoveragePercent } from "./checkCoverage.ts";
import { runTestSuite } from "./runTestSuite.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const coverageDirectory = path.join(projectRoot, "coverage");
const lcovPath = path.join(coverageDirectory, "lcov.info");
const coveredSourceRoots = Object.freeze(["src"]);
const coverageTestTargets = Object.freeze(["scripts", "src"]);

/** @returns Completion after the exact stale LCOV artifact is absent. */
async function removeStaleLcov(): Promise<void> {
    try {
        await unlink(lcovPath);
    } catch (error) {
        if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
            throw error;
        }
    }
}

/**
 * Runs the complete test set with LCOV and enforces the repository threshold.
 * @returns Zero when tests, output policy, and line coverage all pass.
 */
export async function runCoverage(): Promise<number> {
    await mkdir(coverageDirectory, { recursive: true });
    await removeStaleLcov();

    const testExitCode = await runTestSuite(
        [
            "--coverage",
            "--coverage-reporter",
            "text",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            coverageDirectory,
            ...coverageTestTargets,
        ],
        projectRoot
    );
    if (testExitCode !== 0) return testExitCode;

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
