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
    files: readonly string[]
): Promise<LintResult> {
    const process = Bun.spawn(
        [executable, "--config", ".oxlintrc.json", "--format", "unix", ...files],
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
            await symlink(
                path.join(repositoryRoot, "node_modules"),
                path.join(fixtureRoot, "node_modules"),
                "dir"
            );
            await mkdir(path.join(fixtureRoot, "src", "browser"), {
                recursive: true,
            });
            await mkdir(path.join(fixtureRoot, "frontend", "src"), {
                recursive: true,
            });
            await copyFile(
                path.join(repositoryRoot, "frontend", "src", "index.css"),
                path.join(fixtureRoot, "frontend", "src", "index.css")
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
                path.join(fixtureRoot, "src", "worker", "workerConsole.ts"),
                'console.log("forbidden");\n'
            );

            const result = await runOxlint(
                path.join(repositoryRoot, "node_modules", ".bin", "oxlint"),
                fixtureRoot,
                ["src/browser/browserBoundary.ts", "src/worker/workerConsole.ts"]
            );

            expect(result.exitCode).not.toBe(0);
            expect(result.output).toContain("'memo' import from 'react' is restricted");
            expect(result.output).toContain(
                "'../server/privateServer.ts' import is restricted"
            );
            expect(result.output).toContain("no-implied-eval");
            expect(result.output).toContain("no-console");

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
            const testResult = await runOxlint(
                path.join(repositoryRoot, "node_modules", ".bin", "oxlint"),
                fixtureRoot,
                [
                    "src/browser/browserBoundary.spec.ts",
                    "src/browser/__tests__/browserBoundary.ts",
                ]
            );

            expect(testResult.exitCode).toBe(0);
            expect(testResult.output).not.toContain(
                "'memo' import from 'react' is restricted"
            );
            expect(testResult.output).not.toContain("no-implied-eval");
            expect(testResult.output).not.toContain("no-restricted-imports");
            expect(testResult.output).not.toContain("no-console");
        } finally {
            await rm(fixtureRoot, { force: true, recursive: true });
        }
    });
});
