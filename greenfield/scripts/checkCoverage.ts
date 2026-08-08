import path from "node:path";

import { readBoundedUtf8RegularFile } from "./files/boundedFile.ts";
import { discoverSourceFiles } from "./sourceBoundaries/sourceDiscovery.ts";
import { sourceRole } from "./sourceBoundaries/sourceTopologyPolicy.ts";

/** Required repository line coverage percentage. */
export const requiredLineCoveragePercent = 85;

/** Aggregate line coverage for the selected production-source roots. */
export interface LineCoverageSummary {
    readonly foundLines: number;
    readonly hitLines: number;
    readonly percent: number;
}

const maximumLcovBytes = 64 * 1024 * 1024;
const typeScriptModuleExtensions: ReadonlySet<string> = new Set([".cts", ".mts", ".ts"]);

function normalizeCoveragePath(value: string): string {
    return value.replaceAll("\\", "/").replace(/^\.\//u, "").replace(/\/$/u, "");
}

function belongsToRoot(sourcePath: string, sourceRoot: string): boolean {
    return sourcePath === sourceRoot || sourcePath.startsWith(`${sourceRoot}/`);
}

function isStorybookSource(sourcePath: string): boolean {
    const role = sourceRole(sourcePath);
    return role === "story" || role === "storybook-config";
}

function parseLineCount(kind: "LF" | "LH", value: string): number {
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 0) {
        throw new Error(`LCOV contains an invalid ${kind} line count`);
    }
    return count;
}

function transpilerLoader(filePath: string): "js" | "jsx" | "ts" | "tsx" {
    const extension = path.extname(filePath);
    if (extension === ".tsx") return "tsx";
    if (typeScriptModuleExtensions.has(extension)) return "ts";
    if (extension === ".jsx") return "jsx";
    return "js";
}

/**
 * Requires every executable production source file to be present in the LCOV inventory.
 * @param lcov Complete LCOV document.
 * @param expectedSourcePaths Exact repository-relative executable source paths.
 */
export function assertCoverageIncludesSources(
    lcov: string,
    expectedSourcePaths: readonly string[]
): void {
    const reportedSources = new Set(
        lcov
            .split(/\r?\n/u)
            .filter((line) => line.startsWith("SF:"))
            .map((line) => normalizeCoveragePath(line.slice(3)))
    );
    const missingSources = expectedSourcePaths.filter(
        (sourcePath) => !reportedSources.has(normalizeCoveragePath(sourcePath))
    );
    if (missingSources.length > 0) {
        throw new Error(
            `LCOV is missing executable source files:\n${missingSources.join("\n")}`
        );
    }
}

/**
 * Discovers production modules that emit runtime JavaScript and therefore require LCOV.
 * @param projectRoot Absolute repository root.
 * @param sourceRoots Repository-relative roots included in the threshold.
 * @returns Sorted executable source paths, excluding tests, stories, Storybook support, and type-only modules.
 */
export async function discoverExecutableCoverageSources(
    projectRoot: string,
    sourceRoots: readonly string[]
): Promise<readonly string[]> {
    const normalizedRoots = sourceRoots.map((root) => normalizeCoveragePath(root));
    const discovery = await discoverSourceFiles(projectRoot);
    if (discovery.violations.length > 0) {
        throw new Error("Coverage source inventory requires valid source boundaries");
    }

    const transpilers = new Map<string, Bun.Transpiler>();
    const executableSources: string[] = [];
    for (const filePath of discovery.files) {
        if (
            sourceRole(filePath) === "test" ||
            isStorybookSource(filePath) ||
            !normalizedRoots.some((root) => belongsToRoot(filePath, root))
        ) {
            continue;
        }

        const loader = transpilerLoader(filePath);
        let transpiler = transpilers.get(loader);
        if (transpiler === undefined) {
            transpiler = new Bun.Transpiler({ loader, target: "bun" });
            transpilers.set(loader, transpiler);
        }
        const source = await Bun.file(path.join(projectRoot, filePath)).text();
        if (transpiler.transformSync(source).trim().length > 0) {
            executableSources.push(filePath);
        }
    }
    return Object.freeze(executableSources.toSorted());
}

/**
 * Aggregates LCOV line totals for exact repository-relative production roots.
 * @param lcov Complete LCOV document.
 * @param sourceRoots Repository-relative roots included in the threshold.
 * @returns Hit, found, and unrounded percentage totals.
 */
export function summarizeLineCoverage(
    lcov: string,
    sourceRoots: readonly string[]
): LineCoverageSummary {
    const normalizedRoots = sourceRoots.map((root) => normalizeCoveragePath(root));
    if (
        normalizedRoots.length === 0 ||
        normalizedRoots.some(
            (root) =>
                root.length === 0 ||
                root === "." ||
                root === ".." ||
                root.includes("\0") ||
                root.startsWith("../") ||
                path.posix.isAbsolute(root) ||
                /^[A-Za-z]:\//u.test(root)
        )
    ) {
        throw new TypeError("Coverage requires at least one repository source root");
    }

    let countCurrentRecord = false;
    let currentFoundLines: number | undefined;
    let currentHitLines: number | undefined;
    let foundLines = 0;
    let hitLines = 0;

    function finishRecord(): void {
        if (!countCurrentRecord) return;
        if (currentFoundLines === undefined || currentHitLines === undefined) {
            throw new Error("LCOV source record is missing LF or LH line totals");
        }
        if (currentHitLines > currentFoundLines) {
            throw new Error("LCOV hit-line total exceeds its found-line total");
        }
        foundLines += currentFoundLines;
        hitLines += currentHitLines;
    }

    for (const line of lcov.split(/\r?\n/u)) {
        if (line.startsWith("SF:")) {
            finishRecord();
            const sourcePath = normalizeCoveragePath(line.slice(3));
            countCurrentRecord =
                !isStorybookSource(sourcePath) &&
                normalizedRoots.some((root) => belongsToRoot(sourcePath, root));
            currentFoundLines = undefined;
            currentHitLines = undefined;
        } else if (line.startsWith("LF:") && countCurrentRecord) {
            if (currentFoundLines !== undefined) {
                throw new Error("LCOV source record contains duplicate LF totals");
            }
            currentFoundLines = parseLineCount("LF", line.slice(3));
        } else if (line.startsWith("LH:") && countCurrentRecord) {
            if (currentHitLines !== undefined) {
                throw new Error("LCOV source record contains duplicate LH totals");
            }
            currentHitLines = parseLineCount("LH", line.slice(3));
        } else if (line === "end_of_record") {
            finishRecord();
            countCurrentRecord = false;
            currentFoundLines = undefined;
            currentHitLines = undefined;
        }
    }
    finishRecord();

    if (foundLines === 0) {
        throw new Error("LCOV contains no line coverage for the selected source roots");
    }
    return {
        foundLines,
        hitLines,
        percent: (hitLines / foundLines) * 100,
    };
}

/**
 * Requires one aggregate LCOV line-coverage threshold.
 * @param lcov Complete LCOV document.
 * @param thresholdPercent Inclusive percentage threshold.
 * @param sourceRoots Repository-relative production roots included in the threshold.
 * @returns The accepted coverage summary.
 */
export function assertLineCoverage(
    lcov: string,
    thresholdPercent: number,
    sourceRoots: readonly string[]
): LineCoverageSummary {
    if (
        !Number.isFinite(thresholdPercent) ||
        thresholdPercent < 0 ||
        thresholdPercent > 100
    ) {
        throw new TypeError("Coverage threshold must be between zero and 100");
    }

    const summary = summarizeLineCoverage(lcov, sourceRoots);
    if (summary.percent < thresholdPercent) {
        throw new Error(
            `Coverage ${summary.percent.toFixed(2)}% is below required ${thresholdPercent.toFixed(2)}% (${summary.hitLines}/${summary.foundLines} lines)`
        );
    }
    return summary;
}

/**
 * Reads and validates a stable, bounded LCOV artifact from this repository.
 * @param lcovPath Absolute or repository-relative LCOV path.
 * @param thresholdPercent Inclusive line-coverage threshold.
 * @param sourceRoots Repository-relative production roots included in the threshold.
 * @param projectRoot Repository root containing the artifact.
 * @returns The accepted coverage summary.
 */
export async function checkCoverageFile(
    lcovPath: string,
    thresholdPercent: number,
    sourceRoots: readonly string[],
    projectRoot = path.resolve(import.meta.dir, "..")
): Promise<LineCoverageSummary> {
    const resolvedPath = path.resolve(projectRoot, lcovPath);
    const { text } = await readBoundedUtf8RegularFile(
        resolvedPath,
        projectRoot,
        maximumLcovBytes,
        "Coverage artifact is unavailable or invalid",
        "Coverage artifact is not valid UTF-8"
    );
    const summary = assertLineCoverage(text, thresholdPercent, sourceRoots);
    assertCoverageIncludesSources(
        text,
        await discoverExecutableCoverageSources(projectRoot, sourceRoots)
    );
    return summary;
}

async function main(): Promise<void> {
    const [lcovPath, thresholdInput, ...sourceRoots] = process.argv.slice(2);
    const thresholdPercent = Number(thresholdInput);
    if (lcovPath === undefined || thresholdInput === undefined) {
        throw new TypeError(
            "Usage: bun scripts/checkCoverage.ts <lcov.info> <thresholdPercent> <sourceRoot ...>"
        );
    }

    const summary = await checkCoverageFile(lcovPath, thresholdPercent, sourceRoots);
    console.log(
        `Coverage ${summary.percent.toFixed(2)}% meets required ${thresholdPercent.toFixed(2)}% (${summary.hitLines}/${summary.foundLines} lines)`
    );
}

if (import.meta.main) await main();
