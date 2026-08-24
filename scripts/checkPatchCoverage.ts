import path from "node:path";

import { requiredLineCoveragePercent } from "./checkCoverage.ts";

export interface PatchCoverageSummary {
    readonly foundLines: number;
    readonly hitLines: number;
    readonly percent: number;
}

/**
 * Parses added line positions from a zero-context unified Git diff.
 * @param diff Unified Git diff text.
 * @returns Changed line positions grouped by repository-relative file.
 */
export function parseChangedLines(
    diff: string
): ReadonlyMap<string, ReadonlySet<number>> {
    const changed = new Map<string, Set<number>>();
    let filePath: string | undefined;
    for (const line of diff.split("\n")) {
        if (line.startsWith("+++ b/")) {
            filePath = line.slice("+++ b/".length);
            continue;
        }
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/u.exec(line);
        if (hunk === null || filePath === undefined) continue;
        const start = Number(hunk[1]);
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        const lines = changed.get(filePath) ?? new Set<number>();
        for (let offset = 0; offset < count; offset += 1) lines.add(start + offset);
        changed.set(filePath, lines);
    }
    return changed;
}

/**
 * Matches executable changed lines against merged LCOV line hits.
 * @param lcov Merged line-coverage report.
 * @param changed Changed positions grouped by file.
 * @param root Repository root used to normalize absolute LCOV sources.
 * @returns Patch line-coverage summary.
 */
export function summarizePatchCoverage(
    lcov: string,
    changed: ReadonlyMap<string, ReadonlySet<number>>,
    root: string
): PatchCoverageSummary {
    let source: string | undefined;
    let foundLines = 0;
    let hitLines = 0;
    for (const line of lcov.split("\n")) {
        if (line.startsWith("SF:")) {
            const candidate = line.slice(3);
            source = path.isAbsolute(candidate)
                ? path.relative(root, candidate).replaceAll(path.sep, "/")
                : candidate.replaceAll("\\", "/");
            continue;
        }
        const data = /^DA:(\d+),(\d+)/u.exec(line);
        if (data === null || source === undefined) continue;
        const lineNumber = Number(data[1]);
        if (changed.get(source)?.has(lineNumber) !== true) continue;
        foundLines += 1;
        if (Number(data[2]) > 0) hitLines += 1;
    }
    return Object.freeze({
        foundLines,
        hitLines,
        percent: foundLines === 0 ? 100 : (hitLines / foundLines) * 100,
    });
}

async function capture(command: readonly string[], root: string): Promise<string> {
    const child = Bun.spawn([...command], {
        cwd: root,
        stdout: "pipe",
        stderr: "inherit",
    });
    const output = await new Response(child.stdout).text();
    const exitCode = await child.exited;
    if (exitCode !== 0) throw new Error(`${command[0]} exited with code ${exitCode}`);
    return output;
}

/**
 * Runs the PR-base-relative local patch-coverage gate.
 * @param lcovPath Merged LCOV path relative to the repository.
 * @param root Repository root.
 * @param environment Base-selection environment.
 * @returns Accepted patch line-coverage summary.
 */
export async function checkPatchCoverage(
    lcovPath: string,
    root: string,
    environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<PatchCoverageSummary> {
    const configuredBase = environment.MIRA_DASHBOARD_COVERAGE_BASE?.trim();
    const githubBase = environment.GITHUB_BASE_REF?.trim();
    const base = configuredBase || (githubBase ? `origin/${githubBase}` : "origin/main");
    const diff = await capture(
        [
            "git",
            "diff",
            "--unified=0",
            "--diff-filter=ACMR",
            `${base}...HEAD`,
            "--",
            "scripts",
            "src",
            "drizzle.config.ts",
            "tailwind.config.ts",
        ],
        root
    );
    const summary = summarizePatchCoverage(
        await Bun.file(path.resolve(root, lcovPath)).text(),
        parseChangedLines(diff),
        root
    );
    if (summary.percent < requiredLineCoveragePercent) {
        throw new Error(
            `Patch coverage ${summary.percent.toFixed(2)}% is below required ${requiredLineCoveragePercent.toFixed(2)}% (${summary.hitLines}/${summary.foundLines} executable changed lines; base ${base})`
        );
    }
    return summary;
}
