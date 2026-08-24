import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    createStorybookLintCommand,
    discoverStorybookLintFiles,
} from "./lintStorybook.ts";
import { discoverSourceFiles } from "./sourceBoundaries/sourceDiscovery.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function createFixture(files: Readonly<Record<string, string>>): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-storybook-lint-"));
    temporaryDirectories.push(directory);
    await Promise.all(
        Object.entries(files).map(async ([filePath, contents]) => {
            const absolutePath = path.join(directory, filePath);
            await mkdir(path.dirname(absolutePath), { recursive: true });
            await writeFile(absolutePath, contents, { encoding: "utf8", mode: 0o600 });
        })
    );
    return directory;
}

const requiredFixtureFiles = Object.freeze({
    ".storybook/main.ts": "export {};",
    ".storybook/manager.ts": "export {};",
    ".storybook/preview.tsx": "export {};",
    ".storybook/vitest.config.ts": "export {};",
    "scripts/placeholder.ts": "export {};",
});

function isExpectedStorybookLintFile(filePath: string): boolean {
    return (
        filePath === ".storybook/manager.ts" ||
        filePath === ".storybook/preview.tsx" ||
        filePath.endsWith(".stories.tsx") ||
        filePath.includes("/storySupport/")
    );
}

describe("Storybook lint runner", () => {
    test("passes every current story and story-support source as a concrete path", async () => {
        const discoveredSources = await discoverSourceFiles(projectRoot);
        expect(discoveredSources.violations).toEqual([]);
        const expectedFiles = discoveredSources.files.filter(isExpectedStorybookLintFile);
        const files = await discoverStorybookLintFiles(projectRoot);
        const command = createStorybookLintCommand(projectRoot, files);

        expect(files).toEqual(expectedFiles);
        expect(
            files.filter((filePath) => filePath.endsWith(".stories.tsx")).length
        ).toBeGreaterThan(0);
        expect(
            files.filter((filePath) => filePath.includes("/storySupport/")).length
        ).toBeGreaterThan(0);
        expect(command).toEqual([
            path.join(projectRoot, "node_modules", ".bin", "oxlint"),
            "--tsconfig",
            "tsconfig.storybook.json",
            ...expectedFiles,
        ]);
        expect(command).not.toContain("--no-error-on-unmatched-pattern");
        expect(
            command.slice(3).every((argument) => !/[?*{}]/u.test(argument))
        ).toBeTrue();
        expect(createStorybookLintCommand(projectRoot, files, true)).toEqual([
            path.join(projectRoot, "node_modules", ".bin", "oxlint"),
            "--tsconfig",
            "tsconfig.storybook.json",
            "--fix",
            ...expectedFiles,
        ]);
    });

    test("discovers nested story support while excluding ordinary browser source", async () => {
        const fixtureRoot = await createFixture({
            ...requiredFixtureFiles,
            "src/browser/example/Example.stories.tsx": "export {};",
            "src/browser/example/Example.tsx": "export {};",
            "src/browser/example/storySupport/example.ts": "export {};",
            "src/browser/example/storySupport/nested/example.tsx": "export {};",
        });

        expect(await discoverStorybookLintFiles(fixtureRoot)).toEqual([
            ".storybook/manager.ts",
            ".storybook/preview.tsx",
            "src/browser/example/Example.stories.tsx",
            "src/browser/example/storySupport/example.ts",
            "src/browser/example/storySupport/nested/example.tsx",
        ]);
    });

    test("fails closed when source discovery cannot prove the inventory", async () => {
        const fixtureRoot = await createFixture({
            ".storybook/main.ts": "export {};",
            ".storybook/manager.ts": "export {};",
            ".storybook/vitest.config.ts": "export {};",
            "scripts/placeholder.ts": "export {};",
            "src/browser/example/Example.stories.tsx": "export {};",
        });

        expect(discoverStorybookLintFiles(fixtureRoot)).rejects.toThrow(
            "Required Storybook source file is missing"
        );
    });
});
