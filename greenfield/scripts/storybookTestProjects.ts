import path from "node:path";

import {
    assertExactTimedTestPartition,
    discoverReviewedSourceFiles,
} from "./testBatching.ts";

const storyFileSuffix = ".stories.tsx";

/** Story files that require an otherwise idle three-worker Storybook project. */
export const exclusiveStorybookTestFiles: readonly string[] = Object.freeze([
    "src/browser/ui/stories/SourceViewer.stories.tsx",
]);

function exclusiveProjectName(index: number): string {
    return `storybook-exclusive-${String(index + 1).padStart(3, "0")}`;
}

/** Exact projects selected by every repository-owned Storybook command. */
export const storybookTestProjectNames: readonly string[] = Object.freeze([
    ...exclusiveStorybookTestFiles.map((_filePath, index) => exclusiveProjectName(index)),
    "storybook",
]);

/** One disjoint Storybook project and its sequential project-group position. */
export interface StorybookTestProjectPlan {
    readonly excludedFiles: readonly string[];
    readonly groupOrder: number;
    readonly name: string;
    readonly testFiles: readonly string[];
}

function validateStoryFilePath(filePath: string, inventoryName: string): void {
    const pathSegments = filePath.split("/");
    if (
        filePath.length === 0 ||
        filePath.includes("\0") ||
        filePath.includes("\\") ||
        path.posix.isAbsolute(filePath) ||
        path.posix.normalize(filePath) !== filePath ||
        pathSegments.some(
            (segment) => segment.length === 0 || segment === "." || segment === ".."
        ) ||
        !filePath.endsWith(storyFileSuffix)
    ) {
        throw new TypeError(
            `${inventoryName} contains an invalid story path: ${filePath}`
        );
    }
}

function repeatedPaths(paths: readonly string[]): readonly string[] {
    const seen = new Set<string>();
    const duplicates = new Set<string>();
    for (const filePath of paths) {
        if (seen.has(filePath)) duplicates.add(filePath);
        seen.add(filePath);
    }
    return [...duplicates].toSorted();
}

/**
 * Discovers the exact Storybook test-file inventory through reviewed source discovery.
 * @param projectRoot Repository root containing browser stories.
 * @returns Sorted repository-relative story files.
 */
export async function discoverStorybookTestFiles(
    projectRoot: string
): Promise<readonly string[]> {
    const sourceFiles = await discoverReviewedSourceFiles(
        projectRoot,
        "Storybook test inventory"
    );
    const storyFiles = sourceFiles.filter((filePath) =>
        filePath.endsWith(storyFileSuffix)
    );
    if (storyFiles.length === 0) {
        throw new Error("Storybook test inventory contains no stories");
    }
    return Object.freeze(storyFiles);
}

/**
 * Partitions every story into one standard project or one singleton exclusive project.
 * Unique Vitest group orders make exclusive files run alone while the command retains
 * the repository-wide three-worker policy.
 * @param discoveredFiles Exact reviewed Storybook file inventory.
 * @param exclusiveFiles Reviewed files requiring singleton execution.
 * @returns Disjoint project plans whose union is the complete inventory.
 */
export function createStorybookTestProjectPlan(
    discoveredFiles: readonly string[],
    exclusiveFiles: readonly string[] = exclusiveStorybookTestFiles
): readonly StorybookTestProjectPlan[] {
    if (discoveredFiles.length === 0) {
        throw new Error("Storybook project plan contains no discovered stories");
    }
    for (const filePath of discoveredFiles) {
        validateStoryFilePath(filePath, "Storybook project inventory");
    }
    for (const filePath of exclusiveFiles) {
        validateStoryFilePath(filePath, "Exclusive Storybook project policy");
    }

    const duplicateDiscoveredFiles = repeatedPaths(discoveredFiles);
    if (duplicateDiscoveredFiles.length > 0) {
        throw new Error(
            `Storybook project inventory contains duplicate files:\n${duplicateDiscoveredFiles.join("\n")}`
        );
    }
    const duplicateExclusiveFiles = repeatedPaths(exclusiveFiles);
    if (duplicateExclusiveFiles.length > 0) {
        throw new Error(
            `Exclusive Storybook project policy contains duplicate files:\n${duplicateExclusiveFiles.join("\n")}`
        );
    }

    const discoveredSet = new Set(discoveredFiles);
    const missingExclusiveFiles = exclusiveFiles.filter(
        (filePath) => !discoveredSet.has(filePath)
    );
    if (missingExclusiveFiles.length > 0) {
        throw new Error(
            `Exclusive Storybook project files are missing from discovery:\n${missingExclusiveFiles.toSorted().join("\n")}`
        );
    }

    const sortedDiscoveredFiles = discoveredFiles.toSorted();
    const sortedExclusiveFiles = exclusiveFiles.toSorted();
    const exclusiveSet = new Set(sortedExclusiveFiles);
    const standardFiles = sortedDiscoveredFiles.filter(
        (filePath) => !exclusiveSet.has(filePath)
    );
    if (standardFiles.length === 0) {
        throw new Error(
            "Storybook project plan requires at least one standard story file"
        );
    }

    const plans = Object.freeze([
        ...sortedExclusiveFiles.map((filePath, index) =>
            Object.freeze({
                excludedFiles: Object.freeze(
                    sortedDiscoveredFiles.filter((candidate) => candidate !== filePath)
                ),
                groupOrder: index,
                name: exclusiveProjectName(index),
                testFiles: Object.freeze([filePath]),
            })
        ),
        Object.freeze({
            excludedFiles: Object.freeze([...sortedExclusiveFiles]),
            groupOrder: sortedExclusiveFiles.length,
            name: "storybook",
            testFiles: Object.freeze(standardFiles),
        }),
    ] satisfies readonly StorybookTestProjectPlan[]);

    assertExactTimedTestPartition(
        sortedDiscoveredFiles.map((filePath) => ({ durationMs: 0, filePath })),
        plans.map(({ testFiles }) => ({ durationMs: 0, testFiles })),
        "Storybook project ownership"
    );
    return plans;
}
