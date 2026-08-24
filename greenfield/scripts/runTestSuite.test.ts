import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { pruneMissingTestTimings } from "./runTestSuite.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const runnerPath = path.join(import.meta.dir, "runTestSuite.ts");
const temporaryDirectories: string[] = [];

interface RunnerResult {
    readonly exitCode: number;
    readonly stderr: string;
    readonly stdout: string;
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function runFixture(source: string): Promise<RunnerResult> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-test-runner-"));
    temporaryDirectories.push(directory);
    const testPath = path.join(directory, "fixture.test.ts");
    await writeFile(testPath, source, { encoding: "utf8", mode: 0o600 });

    const result = Bun.spawnSync([process.execPath, runnerPath, testPath], {
        cwd: projectRoot,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    return {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
    };
}

describe("test suite runner", () => {
    test("prunes deleted files from Bun's merged timing inventory", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-test-timings-"));
        temporaryDirectories.push(directory);
        const existingTestPath = path.join(directory, "existing.test.ts");
        const deletedTestPath = path.join(directory, "deleted.test.ts");
        const timingsPath = path.join(directory, "timings.json");
        await writeFile(existingTestPath, "", { encoding: "utf8", mode: 0o600 });
        await writeFile(
            timingsPath,
            JSON.stringify({
                files: {
                    [existingTestPath]: 12,
                    [deletedTestPath]: 9,
                },
                version: 1,
            }),
            { encoding: "utf8", mode: 0o600 }
        );

        await pruneMissingTestTimings(timingsPath, projectRoot);

        expect(await Bun.file(timingsPath).json()).toEqual({
            files: { [existingTestPath]: 12 },
            version: 1,
        });
    });

    test("preserves a passing test result", async () => {
        const result = await runFixture(`
            import { expect, test } from "bun:test";
            test("passes", () => expect(2 + 2).toBe(4));
        `);

        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("Test output policy failed");
    });

    test("fails a passing test that emits a React act warning", async () => {
        const result = await runFixture(`
            import { expect, test } from "bun:test";
            test("warns", () => {
                console.error("An update inside a test was not wrapped in act(...)");
                expect(true).toBe(true);
            });
        `);

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain(
            "Test output policy failed: React update was not wrapped in act(...)."
        );
    });

    test("preserves a failing test result", async () => {
        const result = await runFixture(`
            import { expect, test } from "bun:test";
            test("fails", () => expect("actual").toBe("expected"));
        `);

        expect(result.exitCode).not.toBe(0);
        expect(result.stdout + result.stderr).toContain("actual");
    });
});
