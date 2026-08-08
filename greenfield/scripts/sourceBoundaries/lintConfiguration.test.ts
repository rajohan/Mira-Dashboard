import { describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

interface LintResult {
    readonly exitCode: number;
    readonly output: string;
}

async function runOxlint(
    executable: string,
    projectRoot: string,
    tsconfig: string,
    files: readonly string[]
): Promise<LintResult> {
    const process = Bun.spawn(
        [
            executable,
            "--config",
            ".oxlintrc.json",
            "--format",
            "unix",
            "--tsconfig",
            tsconfig,
            ...files,
        ],
        {
            cwd: projectRoot,
            env: { ...globalThis.process.env, NO_COLOR: "1" },
            stderr: "pipe",
            stdout: "pipe",
        }
    );
    const [exitCode, stderr, stdout] = await Promise.all([
        process.exited,
        new Response(process.stderr).text(),
        new Response(process.stdout).text(),
    ]);
    return { exitCode, output: `${stdout}\n${stderr}` };
}

describe("effective source-boundary lint configuration", () => {
    test("applies memoization, browser-boundary, and worker-console rules together", async () => {
        const repositoryRoot = path.resolve(import.meta.dir, "../..");
        const fixtureRoot = await mkdtemp(path.join(tmpdir(), "mira-oxlint-boundary-"));
        try {
            await copyFile(
                path.join(repositoryRoot, ".oxlintrc.json"),
                path.join(fixtureRoot, ".oxlintrc.json")
            );
            for (const configurationName of [
                "tsconfig.json",
                "tsconfig.browser.json",
                "tsconfig.bun.json",
                "tsconfig.storybook.json",
            ] as const) {
                await copyFile(
                    path.join(repositoryRoot, configurationName),
                    path.join(fixtureRoot, configurationName)
                );
            }
            await symlink(
                path.join(repositoryRoot, "node_modules"),
                path.join(fixtureRoot, "node_modules"),
                "dir"
            );
            await mkdir(path.join(fixtureRoot, "src", "browser"), {
                recursive: true,
            });
            await mkdir(path.join(fixtureRoot, ".storybook"));
            await mkdir(path.join(fixtureRoot, "src", "test", "types"), {
                recursive: true,
            });
            await copyFile(
                path.join(
                    repositoryRoot,
                    "src",
                    "test",
                    "types",
                    "bunCanaryMatchers.d.ts"
                ),
                path.join(fixtureRoot, "src", "test", "types", "bunCanaryMatchers.d.ts")
            );
            await copyFile(
                path.join(
                    repositoryRoot,
                    "src",
                    "browser",
                    "test",
                    "fixtures",
                    "frontendBuild",
                    "src",
                    "index.css"
                ),
                path.join(fixtureRoot, "src", "browser", "index.css")
            );
            await mkdir(path.join(fixtureRoot, "src", "server"), {
                recursive: true,
            });
            await mkdir(path.join(fixtureRoot, "src", "worker"), {
                recursive: true,
            });
            await writeFile(
                path.join(fixtureRoot, "src", "server", "privateServer.ts"),
                "export const privateServerValue = 1;\n"
            );
            await writeFile(
                path.join(fixtureRoot, "src", "browser", "browserBoundary.ts"),
                'import { memo } from "react";\nimport { privateServerValue } from "../server/privateServer.ts";\nconst timerCode: string = "globalThis.compromised = true";\nsetTimeout(timerCode, 0);\nexport const browserBoundary = [memo, privateServerValue] as const;\n'
            );
            await writeFile(
                path.join(fixtureRoot, ".storybook", "manager.ts"),
                'import { readFile } from "node:fs";\nexport const managerBoundary = readFile;\n'
            );
            await writeFile(
                path.join(fixtureRoot, ".storybook", "preview.tsx"),
                'import { privateServerValue } from "../src/server/privateServer.ts";\nexport const previewBoundary = privateServerValue;\n'
            );
            await writeFile(
                path.join(fixtureRoot, "src", "browser", "catalog.stories.tsx"),
                'import { privateServerValue } from "../server/privateServer.ts";\nexport const storyBoundary = privateServerValue;\n'
            );
            await writeFile(
                path.join(fixtureRoot, "src", "worker", "workerConsole.ts"),
                'console.log("forbidden");\n'
            );
            const testFixtureSource =
                'import { memo } from "react";\nimport { privateServerValue } from "../server/privateServer.ts";\nexport const testBoundary = [memo, privateServerValue] as const;\n';
            await writeFile(
                path.join(fixtureRoot, "src", "browser", "browserBoundary.spec.ts"),
                testFixtureSource
            );
            await mkdir(path.join(fixtureRoot, "src", "browser", "__tests__"));
            await writeFile(
                path.join(
                    fixtureRoot,
                    "src",
                    "browser",
                    "__tests__",
                    "browserBoundary.ts"
                ),
                testFixtureSource.replace(
                    '"../server/privateServer.ts"',
                    '"../../server/privateServer.ts"'
                )
            );

            const executable = path.join(
                repositoryRoot,
                "node_modules",
                ".bin",
                "oxlint"
            );
            const [browserResult, storybookResult, workerResult] = await Promise.all([
                runOxlint(executable, fixtureRoot, "tsconfig.browser.json", [
                    "src/browser/browserBoundary.ts",
                    "src/browser/browserBoundary.spec.ts",
                    "src/browser/__tests__/browserBoundary.ts",
                ]),
                runOxlint(executable, fixtureRoot, "tsconfig.storybook.json", [
                    ".storybook/manager.ts",
                    ".storybook/preview.tsx",
                    "src/browser/catalog.stories.tsx",
                ]),
                runOxlint(executable, fixtureRoot, "tsconfig.bun.json", [
                    "src/worker/workerConsole.ts",
                ]),
            ]);
            const result = {
                exitCode:
                    browserResult.exitCode +
                    storybookResult.exitCode +
                    workerResult.exitCode,
                output: `${browserResult.output}\n${storybookResult.output}\n${workerResult.output}`,
            };

            expect(result.exitCode).not.toBe(0);
            expect(result.output).toContain("'memo' import from 'react' is restricted");
            expect(result.output).toContain(
                "'../server/privateServer.ts' import is restricted"
            );
            expect(result.output).toContain("no-implied-eval");
            expect(result.output).toContain("no-console");
            expect(result.output).toContain(".storybook/manager.ts");
            expect(result.output).toContain(".storybook/preview.tsx");
            expect(result.output).toContain("catalog.stories.tsx");
            expect(result.output).toContain("'node:fs' import is restricted");
            expect(result.output).not.toContain("browserBoundary.spec.ts");
            expect(result.output).not.toContain("__tests__/browserBoundary.ts");
        } finally {
            await rm(fixtureRoot, { force: true, recursive: true });
        }
    }, 30_000);
});
