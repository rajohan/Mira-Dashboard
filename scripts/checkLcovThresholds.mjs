#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_COVERAGE_DIR = "coverage/chunks";
const DEFAULT_THRESHOLDS = {
    branches: 87,
    functions: 96,
    lines: 95,
    statements: 95,
};

/** Parses and validates one numeric coverage threshold flag. */
function parseThreshold(metricName, rawValue) {
    const value = Number(rawValue);
    if (!Number.isFinite(value) || value < 0 || value > 100) {
        throw new Error(
            `Invalid --${metricName} value: "${rawValue}". Expected a number between 0 and 100.`
        );
    }
    return value;
}

/** Parses CLI flags for coverage threshold checks. */
function parseArgs(args) {
    const options = {
        coverageDir: DEFAULT_COVERAGE_DIR,
        thresholds: { ...DEFAULT_THRESHOLDS },
    };

    for (const arg of args) {
        if (arg.startsWith("--coverage-dir=")) {
            options.coverageDir = arg.slice("--coverage-dir=".length);
        } else if (arg.startsWith("--branches=")) {
            options.thresholds.branches = parseThreshold(
                "branches",
                arg.slice("--branches=".length)
            );
        } else if (arg.startsWith("--functions=")) {
            options.thresholds.functions = parseThreshold(
                "functions",
                arg.slice("--functions=".length)
            );
        } else if (arg.startsWith("--lines=")) {
            options.thresholds.lines = parseThreshold(
                "lines",
                arg.slice("--lines=".length)
            );
        } else if (arg.startsWith("--statements=")) {
            options.thresholds.statements = parseThreshold(
                "statements",
                arg.slice("--statements=".length)
            );
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

/** Finds named coverage report files below the coverage directory. */
function collectCoverageFiles(directory, fileName) {
    if (!existsSync(directory)) return [];

    const entries = readdirSync(directory, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...collectCoverageFiles(fullPath, fileName));
        } else if (entry.isFile() && entry.name === fileName) {
            files.push(fullPath);
        }
    }

    return files.sort();
}

/** Creates an empty coverage record for one source file. */
function createFileCoverage() {
    return {
        branches: new Map(),
        functions: new Map(),
        lines: new Map(),
        statements: new Map(),
    };
}

/** Converts LCOV's branch taken value into a numeric hit count. */
function parseTaken(value) {
    if (value === "-" || value === undefined) return 0;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
}

/** Records the highest observed line hit count for a file. */
function mergeLine(fileCoverage, lineNumber, hits) {
    const previous = fileCoverage.lines.get(lineNumber) ?? 0;
    fileCoverage.lines.set(lineNumber, Math.max(previous, hits));
}

/** Records the highest observed function hit count for a file. */
function mergeFunction(fileCoverage, functionKey, hits) {
    const previous = fileCoverage.functions.get(functionKey) ?? 0;
    fileCoverage.functions.set(functionKey, Math.max(previous, hits));
}

/** Records the highest observed branch hit count for a file. */
function mergeBranch(fileCoverage, branchKey, hits) {
    const previous = fileCoverage.branches.get(branchKey) ?? 0;
    fileCoverage.branches.set(branchKey, Math.max(previous, hits));
}

/** Records the highest observed statement hit count for a file. */
function mergeStatement(fileCoverage, statementKey, hits) {
    const previous = fileCoverage.statements.get(statementKey) ?? 0;
    fileCoverage.statements.set(statementKey, Math.max(previous, hits));
}

/** Builds a stable statement key from Istanbul's statement location. */
function statementKey(statementId, location) {
    if (!location?.start || !location?.end) return statementId;
    const locationKey = [
        location.start.line,
        location.start.column,
        location.end.line,
        location.end.column,
    ].join(":");
    return `${statementId}:${locationKey}`;
}

/** Merges one LCOV report into the aggregate coverage map. */
function mergeLcovFile(coverageByFile, lcovFile) {
    let currentCoverage = null;
    let functionDefinitions = new Map();
    let functionHitsByName = new Map();

    const resetRecordState = () => {
        functionDefinitions = new Map();
        functionHitsByName = new Map();
    };

    const functionKeyForHit = (functionName) => {
        const hitIndex = functionHitsByName.get(functionName) ?? 0;
        functionHitsByName.set(functionName, hitIndex + 1);
        const definitions = functionDefinitions.get(functionName) ?? [];
        return definitions[hitIndex] ?? `unknown:${hitIndex}:${functionName}`;
    };

    for (const line of readFileSync(lcovFile, "utf8").split(/\r?\n/u)) {
        if (line.startsWith("SF:")) {
            resetRecordState();
            const currentFile = line.slice(3);
            currentCoverage = coverageByFile.get(currentFile) ?? createFileCoverage();
            coverageByFile.set(currentFile, currentCoverage);
        } else if (line.startsWith("DA:") && currentCoverage) {
            const [lineNumber, hits] = line.slice(3).split(",");
            mergeLine(currentCoverage, lineNumber, Number(hits));
        } else if (line.startsWith("FN:") && currentCoverage) {
            const [lineNumber, functionName] = line.slice(3).split(",");
            const definitions = functionDefinitions.get(functionName) ?? [];
            definitions.push(`${lineNumber}:${definitions.length}:${functionName}`);
            functionDefinitions.set(functionName, definitions);
        } else if (line.startsWith("FNDA:") && currentCoverage) {
            const [hits, functionName] = line.slice(5).split(",");
            mergeFunction(currentCoverage, functionKeyForHit(functionName), Number(hits));
        } else if (line.startsWith("BRDA:") && currentCoverage) {
            const [lineNumber, block, branch, taken] = line.slice(5).split(",");
            mergeBranch(
                currentCoverage,
                `${lineNumber}:${block}:${branch}`,
                parseTaken(taken)
            );
        } else if (line === "end_of_record") {
            currentCoverage = null;
            resetRecordState();
        }
    }
}

/** Merges one Istanbul JSON report into the aggregate coverage map. */
function mergeJsonCoverageFile(coverageByFile, coverageJsonFile) {
    const report = JSON.parse(readFileSync(coverageJsonFile, "utf8"));

    for (const [sourceFile, coverage] of Object.entries(report)) {
        const currentCoverage = coverageByFile.get(sourceFile) ?? createFileCoverage();
        coverageByFile.set(sourceFile, currentCoverage);

        for (const [statementId, hits] of Object.entries(coverage.s ?? {})) {
            mergeStatement(
                currentCoverage,
                statementKey(statementId, coverage.statementMap?.[statementId]),
                Number(hits)
            );
        }
    }
}

/** Calculates totals and percentages from merged coverage records. */
function summarizeCoverage(coverageByFile) {
    const totals = {
        branches: { covered: 0, total: 0 },
        functions: { covered: 0, total: 0 },
        lines: { covered: 0, total: 0 },
        statements: { covered: 0, total: 0 },
    };

    for (const fileCoverage of coverageByFile.values()) {
        totals.branches.total += fileCoverage.branches.size;
        totals.functions.total += fileCoverage.functions.size;
        totals.lines.total += fileCoverage.lines.size;
        totals.statements.total += fileCoverage.statements.size;

        totals.branches.covered += [...fileCoverage.branches.values()].filter(
            (hits) => hits > 0
        ).length;
        totals.functions.covered += [...fileCoverage.functions.values()].filter(
            (hits) => hits > 0
        ).length;
        totals.lines.covered += [...fileCoverage.lines.values()].filter(
            (hits) => hits > 0
        ).length;
        totals.statements.covered += [...fileCoverage.statements.values()].filter(
            (hits) => hits > 0
        ).length;
    }

    return totals;
}

/** Converts covered and total counts into a percentage. */
function percentage({ covered, total }) {
    return total === 0 ? 100 : (covered / total) * 100;
}

/** Formats one coverage metric for console output. */
function formatMetric(name, metric, threshold) {
    return `${name.padEnd(9)} ${percentage(metric).toFixed(2)}% (${metric.covered}/${metric.total}) threshold ${threshold}%`;
}

/** Checks merged coverage against the configured thresholds. */
function checkThresholds(summary, thresholds) {
    const failures = [];

    for (const metricName of ["lines", "functions", "branches", "statements"]) {
        const actual = percentage(summary[metricName]);
        const required = thresholds[metricName];
        if (actual < required) {
            failures.push(`${metricName}: ${actual.toFixed(2)}% < ${required}%`);
        }
    }

    return failures;
}

const { coverageDir, thresholds } = parseArgs(process.argv.slice(2));
const coveragePath = path.resolve(process.cwd(), coverageDir);
const lcovFiles = collectCoverageFiles(coveragePath, "lcov.info");
const jsonCoverageFiles = collectCoverageFiles(coveragePath, "coverage-final.json");

if (lcovFiles.length === 0) {
    console.error(`No LCOV files found below ${coveragePath}.`);
    process.exit(1);
}

if (jsonCoverageFiles.length === 0) {
    console.error(`No coverage-final.json files found below ${coveragePath}.`);
    process.exit(1);
}

const coverageByFile = new Map();

for (const lcovFile of lcovFiles) {
    mergeLcovFile(coverageByFile, lcovFile);
}

for (const jsonCoverageFile of jsonCoverageFiles) {
    mergeJsonCoverageFile(coverageByFile, jsonCoverageFile);
}

const summary = summarizeCoverage(coverageByFile);

console.log(
    `Merged ${lcovFiles.length} LCOV reports and ${jsonCoverageFiles.length} JSON reports from ${coverageDir}.`
);
console.log(formatMetric("Lines", summary.lines, thresholds.lines));
console.log(formatMetric("Functions", summary.functions, thresholds.functions));
console.log(formatMetric("Branches", summary.branches, thresholds.branches));
console.log(formatMetric("Statements", summary.statements, thresholds.statements));

const failures = checkThresholds(summary, thresholds);

if (failures.length > 0) {
    console.error(`Coverage thresholds failed: ${failures.join(", ")}.`);
    process.exit(1);
}

console.log("Coverage thresholds passed.");
