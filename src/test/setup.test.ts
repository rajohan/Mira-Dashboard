import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { runTestProcess } from "../../scripts/runTestSuite.ts";

const projectRoot = path.resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

interface SetupLifecycleEvidence {
    readonly processId: number;
    readonly rootAtImport: string;
    readonly rootAtTest: string;
}

async function expectMissingPath(filePath: string): Promise<void> {
    let failure: unknown;
    try {
        await stat(filePath);
    } catch (error) {
        failure = error;
    }
    expect(failure).toMatchObject({ code: "ENOENT" });
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

function setupLifecycleFixture(evidencePath: string, fixtureName: string): string {
    return `
        import { expect, test } from "bun:test";
        import { stat, writeFile } from "node:fs/promises";
        import { tmpdir } from "node:os";

        const rootAtImport = process.env.MIRA_DASHBOARD_PROJECT_ROOT;
        if (rootAtImport === undefined) {
            throw new Error("Expected a test project root during module evaluation");
        }
        const importStatus = await stat(rootAtImport);
        if (!importStatus.isDirectory()) {
            throw new Error("Expected the module-evaluation test root to exist");
        }
        if (tmpdir() !== rootAtImport) {
            throw new Error("Expected a private temporary root during module evaluation");
        }

        test(${JSON.stringify(fixtureName)}, async () => {
            const rootAtTest = process.env.MIRA_DASHBOARD_PROJECT_ROOT;
            if (rootAtTest === undefined) {
                throw new Error("Expected a test project root during test execution");
            }
            const testStatus = await stat(rootAtTest);
            expect(process.env.NODE_ENV).toBe("test");
            expect(process.env.TEMP).toBe(rootAtTest);
            expect(process.env.TMP).toBe(rootAtTest);
            expect(process.env.TMPDIR).toBe(rootAtTest);
            expect(tmpdir()).toBe(rootAtTest);
            expect(testStatus.isDirectory()).toBe(true);
            expect(testStatus.mode & 0o777).toBe(0o700);
            await writeFile(
                ${JSON.stringify(evidencePath)},
                JSON.stringify({
                    processId: process.pid,
                    rootAtImport,
                    rootAtTest,
                }),
                { encoding: "utf8", mode: 0o600 }
            );
        });
    `;
}

describe("test process setup", () => {
    test("pins ambient project and temporary paths to one private test root", async () => {
        const projectRoot = process.env.MIRA_DASHBOARD_PROJECT_ROOT;
        if (projectRoot === undefined) throw new Error("Expected a test project root");

        const status = await stat(projectRoot);
        expect(process.env.NODE_ENV).toBe("test");
        expect(tmpdir()).toBe(projectRoot);
        expect(process.env.TEMP).toBe(projectRoot);
        expect(process.env.TMP).toBe(projectRoot);
        expect(process.env.TMPDIR).toBe(projectRoot);
        expect(path.basename(projectRoot)).toStartWith("mira-dashboard-test-");
        expect(status.isDirectory()).toBe(true);
        expect(status.mode & 0o777).toBe(0o700);
    });

    test("keeps one private root across files in a reused worker and removes it on exit", async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "setup-lifecycle-"));
        temporaryDirectories.push(directory);
        const fixturePaths = await Promise.all(
            Array.from({ length: 4 }, async (_, index) => {
                const fixturePath = path.join(directory, `fixture-${index}.test.ts`);
                await writeFile(
                    fixturePath,
                    setupLifecycleFixture(
                        path.join(directory, `evidence-${index}.json`),
                        `fixture ${index}`
                    ),
                    { encoding: "utf8", mode: 0o600 }
                );
                return fixturePath;
            })
        );

        const exitCode = await runTestProcess(
            [
                process.execPath,
                "test",
                "--bail=1",
                "--only-failures",
                "--parallel=3",
                "--no-isolate",
                ...fixturePaths,
            ],
            projectRoot
        );
        expect(exitCode).toBe(0);

        const evidence = await Promise.all(
            Array.from({ length: 4 }, (_, index) =>
                Bun.file(path.join(directory, `evidence-${index}.json`)).json()
            )
        ).then((records) => records as SetupLifecycleEvidence[]);
        const evidenceByProcess = Map.groupBy(evidence, (record) => record.processId);
        expect(new Set(evidence.map((record) => record.rootAtImport)).size).toBe(
            evidenceByProcess.size
        );
        for (const records of evidenceByProcess.values()) {
            expect(new Set(records.map((record) => record.rootAtImport)).size).toBe(1);
        }
        const reusedWorkerEvidence = [...evidenceByProcess.values()].find(
            (records) => records.length >= 2
        );
        expect(reusedWorkerEvidence).toBeDefined();
        expect(
            new Set(reusedWorkerEvidence?.map((record) => record.rootAtImport)).size
        ).toBe(1);
        for (const record of evidence) {
            expect(record.rootAtTest).toBe(record.rootAtImport);
            await expectMissingPath(record.rootAtImport);
        }
    });
});
