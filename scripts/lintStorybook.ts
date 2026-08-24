import path from "node:path";

import { discoverSourceFiles } from "./sourceBoundaries/sourceDiscovery.ts";
import { sourceRole } from "./sourceBoundaries/sourceTopologyPolicy.ts";

const requiredStorybookLintFiles = Object.freeze([
    ".storybook/manager.ts",
    ".storybook/preview.tsx",
]);

function renderDiscoveryViolation(violation: {
    readonly importer: string;
    readonly line: number;
    readonly message: string;
}): string {
    return `${violation.importer}:${violation.line}: ${violation.message}`;
}

/**
 * Discovers the exact Storybook-owned source inventory without shell glob expansion.
 * @param projectRoot Repository root containing Storybook and browser sources.
 * @returns Sorted repository-relative files owned by the Storybook lint partition.
 */
export async function discoverStorybookLintFiles(
    projectRoot: string
): Promise<readonly string[]> {
    const discovery = await discoverSourceFiles(projectRoot);
    if (discovery.violations.length > 0) {
        throw new Error(
            `Storybook lint inventory requires valid source discovery:\n${discovery.violations.map(renderDiscoveryViolation).join("\n")}`
        );
    }

    const files = discovery.files.filter((filePath) => sourceRole(filePath) === "story");
    const missingRequiredFiles = requiredStorybookLintFiles.filter(
        (filePath) => !files.includes(filePath)
    );
    if (missingRequiredFiles.length > 0) {
        throw new Error(
            `Storybook lint inventory is missing required files:\n${missingRequiredFiles.join("\n")}`
        );
    }
    if (!files.some((filePath) => filePath.endsWith(".stories.tsx"))) {
        throw new Error("Storybook lint inventory contains no stories");
    }
    return Object.freeze(files);
}

/**
 * Creates one pinned Oxlint command with concrete paths for the complete inventory.
 * @param projectRoot Repository root containing the pinned Oxlint executable.
 * @param files Exact repository-relative Storybook-owned source inventory.
 * @param fix Whether Oxlint should apply safe automatic fixes.
 * @returns Executable and arguments with no shell-expanded patterns.
 */
export function createStorybookLintCommand(
    projectRoot: string,
    files: readonly string[],
    fix = false
): readonly string[] {
    if (files.length === 0) throw new TypeError("Storybook lint requires source files");
    return Object.freeze([
        path.join(projectRoot, "node_modules", ".bin", "oxlint"),
        "--tsconfig",
        "tsconfig.storybook.json",
        ...(fix ? ["--fix"] : []),
        ...files,
    ]);
}

/**
 * Lints every Storybook-owned source through one explicitly inventoried Oxlint process.
 * @param projectRoot Repository root used for discovery and child execution.
 * @param fix Whether Oxlint should apply safe automatic fixes.
 * @returns The Oxlint child exit code.
 */
export async function runStorybookLint(
    projectRoot = path.resolve(import.meta.dir, ".."),
    fix = false
): Promise<number> {
    const files = await discoverStorybookLintFiles(projectRoot);
    const child = Bun.spawn([...createStorybookLintCommand(projectRoot, files, fix)], {
        cwd: projectRoot,
        stderr: "inherit",
        stdin: "inherit",
        stdout: "inherit",
    });
    const exitCode = await child.exited;
    if (exitCode === 0) {
        console.log(`Storybook lint: ${files.length} files`);
    }
    return exitCode;
}

if (import.meta.main) {
    const arguments_ = process.argv.slice(2);
    if (
        arguments_.length > 1 ||
        (arguments_[0] !== undefined && arguments_[0] !== "--fix")
    ) {
        throw new TypeError("Usage: bun scripts/lintStorybook.ts [--fix]");
    }
    process.exitCode = await runStorybookLint(
        path.resolve(import.meta.dir, ".."),
        arguments_[0] === "--fix"
    );
}
