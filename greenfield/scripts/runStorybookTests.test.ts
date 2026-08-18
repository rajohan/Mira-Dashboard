import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
    prepareStorybookBrowserStorage,
    resetStorybookBrowserStorage,
} from "../src/browser/storySupport/storybookBrowserStorage.ts";
import {
    createStorybookTestCommand,
    discoverStorybookTestFiles,
    parseStorybookTimingReport,
    runStorybookTests,
} from "./runStorybookTests.ts";
import {
    createStorybookTestProjectPlan,
    exclusiveStorybookTestFiles,
    storybookTestProjectNames,
} from "./storybookTestProjects.ts";
import {
    createExactTimedTestInventory,
    parseTestTimingsInventory,
    readTestTimingsInventory,
} from "./testBatching.ts";

const projectRoot = path.resolve(import.meta.dir, "..");
const temporaryDirectories: string[] = [];

function createMemoryStorage(): Storage {
    const entries = new Map<string, string>();
    return {
        get length() {
            return entries.size;
        },
        clear() {
            entries.clear();
        },
        getItem(key) {
            return entries.get(key) ?? null;
        },
        key(index) {
            return [...entries.keys()][index] ?? null;
        },
        removeItem(key) {
            entries.delete(key);
        },
        setItem(key, value) {
            entries.set(key, value);
        },
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function createTemporaryInventory(
    files: Readonly<Record<string, number>>
): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-storybook-runner-"));
    temporaryDirectories.push(directory);
    const inventoryPath = path.join(directory, "timings.json");
    await writeFile(
        inventoryPath,
        `${JSON.stringify({ files, version: 1 }, null, 4)}\n`,
        { encoding: "utf8", mode: 0o600 }
    );
    return inventoryPath;
}

function storyFilesFromCommand(command: readonly string[]): readonly string[] {
    return command.filter((argument) => argument.endsWith(".stories.tsx"));
}

function timingReportPath(command: readonly string[]): string {
    const argument = command.find((item) => item.startsWith("--outputFile.json="));
    if (argument === undefined) throw new Error("Missing JSON timing report path");
    return argument.slice("--outputFile.json=".length);
}

async function writePassingTimingReport(
    command: readonly string[],
    durationForFile: (filePath: string) => number = () => 100
): Promise<void> {
    const testResults = storyFilesFromCommand(command).map((filePath) => ({
        endTime: 1000 + durationForFile(filePath),
        name: path.join(projectRoot, filePath),
        startTime: 1000,
        status: "passed",
    }));
    await writeFile(
        timingReportPath(command),
        JSON.stringify({
            numFailedTestSuites: 0,
            numFailedTests: 0,
            numPendingTestSuites: 0,
            numPendingTests: 0,
            numTodoTests: 0,
            success: true,
            testResults,
        }),
        { encoding: "utf8", mode: 0o600 }
    );
}

describe("Storybook test runner", () => {
    test("clears persistent browser state before and after every story", async () => {
        const localStorageDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            "localStorage"
        );
        const sessionStorageDescriptor = Object.getOwnPropertyDescriptor(
            globalThis,
            "sessionStorage"
        );
        const localStorage = createMemoryStorage();
        const sessionStorage = createMemoryStorage();
        Object.defineProperties(globalThis, {
            localStorage: { configurable: true, value: localStorage },
            sessionStorage: { configurable: true, value: sessionStorage },
        });
        try {
            const previewSource = await readFile(
                path.join(projectRoot, ".storybook", "preview.tsx"),
                "utf8"
            );
            expect(previewSource).toContain("afterEach: resetStorybookBrowserStorage");
            expect(previewSource).toContain("beforeEach: prepareStorybookBrowserStorage");

            localStorage.setItem("chat-preference", "retained");
            sessionStorage.setItem("restart-recovery", "retained");
            prepareStorybookBrowserStorage();
            expect(localStorage.length).toBe(0);
            expect(sessionStorage.length).toBe(0);

            localStorage.setItem("chat-preference", "completed-story");
            sessionStorage.setItem("restart-recovery", "completed-story");
            resetStorybookBrowserStorage();
            expect(localStorage.length).toBe(0);
            expect(sessionStorage.length).toBe(0);
        } finally {
            if (localStorageDescriptor === undefined) {
                Reflect.deleteProperty(globalThis, "localStorage");
            } else {
                Object.defineProperty(globalThis, "localStorage", localStorageDescriptor);
            }
            if (sessionStorageDescriptor === undefined) {
                Reflect.deleteProperty(globalThis, "sessionStorage");
            } else {
                Object.defineProperty(
                    globalThis,
                    "sessionStorage",
                    sessionStorageDescriptor
                );
            }
        }
    });

    test("matches all current stories to the tracked timing inventory", async () => {
        const storyFiles = await discoverStorybookTestFiles(projectRoot);
        const timings = await readTestTimingsInventory(
            ".storybook-test-timings.json",
            projectRoot
        );
        const inventory = createExactTimedTestInventory(storyFiles, timings, {
            inventoryName: "Storybook test timing inventory",
            isTestFile: (filePath) => filePath.endsWith(".stories.tsx"),
        });

        expect(storyFiles.length).toBe(Object.keys(timings.files).length);
        expect(storyFiles.length).toBeGreaterThan(0);
        expect(inventory.map(({ filePath }) => filePath)).toEqual(storyFiles);
    });

    test("remounts every stateful full-page harness for each story", async () => {
        const storyFiles = await discoverStorybookTestFiles(projectRoot);
        const fullPageStories: string[] = [];
        for (const storyFile of storyFiles) {
            const source = await readFile(path.join(projectRoot, storyFile), "utf8");
            if (!source.includes("component: DashboardPageStory")) continue;
            fullPageStories.push(storyFile);
            expect(source).toContain(
                "render: (args, context) => <DashboardPageStory {...args} key={context.id} />"
            );
        }
        expect(fullPageStories).not.toBeEmpty();
    });

    test("uses three file-parallel workers and optional official JSON output", () => {
        expect(createStorybookTestCommand("/tmp/dashboard", ["a.stories.tsx"])).toEqual([
            "/tmp/dashboard/node_modules/.bin/vitest",
            "run",
            "--config",
            ".storybook/vitest.config.ts",
            "--project=storybook-exclusive-001",
            "--project=storybook",
            "--maxWorkers=3",
            "--no-isolate",
            "a.stories.tsx",
        ]);
        expect(
            createStorybookTestCommand("/tmp/dashboard", ["a.stories.tsx"], {
                timingReportPath: "/tmp/report.json",
            })
        ).toEqual([
            "/tmp/dashboard/node_modules/.bin/vitest",
            "run",
            "--config",
            ".storybook/vitest.config.ts",
            "--project=storybook-exclusive-001",
            "--project=storybook",
            "--maxWorkers=3",
            "--no-isolate",
            "--reporter=default",
            "--reporter=json",
            "--outputFile.json=/tmp/report.json",
            "a.stories.tsx",
        ]);

        const coverageCommand = createStorybookTestCommand(
            "/tmp/dashboard",
            ["a.stories.tsx"],
            { coverageDirectory: "/tmp/coverage/storybook-001" }
        );
        expect(coverageCommand.slice(0, 9)).toEqual([
            "/tmp/dashboard/node_modules/.bin/vitest",
            "run",
            "--config",
            ".storybook/vitest.config.ts",
            "--project=storybook-exclusive-001",
            "--project=storybook",
            "--maxWorkers=3",
            "--no-isolate",
            "--coverage",
        ]);
        expect(
            coverageCommand
                .filter((argument) => argument.startsWith("--project="))
                .map((argument) => argument.slice("--project=".length))
        ).toEqual(storybookTestProjectNames);
        expect(coverageCommand).toContain("--coverage.provider=v8");
        expect(coverageCommand).toContain("--coverage.reporter=lcov");
        expect(coverageCommand).toContain("--coverage.processingConcurrency=3");
        expect(coverageCommand).toContain("--coverage.excludeAfterRemap=true");
        expect(coverageCommand).toContain(
            "--coverage.exclude=src/browser/storySupport/**"
        );
        expect(coverageCommand.at(-1)).toBe("a.stories.tsx");
        expect(() =>
            createStorybookTestCommand("/tmp/dashboard", ["a.stories.tsx"], {
                coverageDirectory: "relative-coverage",
            })
        ).toThrow("coverage directory must be absolute");
    });

    test("assigns every story to one group-ordered project exactly once", async () => {
        const storyFiles = await discoverStorybookTestFiles(projectRoot);
        const plans = createStorybookTestProjectPlan(storyFiles);
        const executed = plans.flatMap(({ testFiles }) => testFiles);
        const exclusivePlans = plans.filter(({ name }) => name !== "storybook");
        const standardPlan = plans.find(({ name }) => name === "storybook");

        expect(plans.map(({ name }) => name)).toEqual(storybookTestProjectNames);
        expect(plans.map(({ groupOrder }) => groupOrder)).toEqual([0, 1]);
        expect(exclusivePlans).toHaveLength(exclusiveStorybookTestFiles.length);
        expect(exclusivePlans[0]?.testFiles).toEqual(exclusiveStorybookTestFiles);
        expect(exclusivePlans[0]?.excludedFiles).not.toContain(
            exclusiveStorybookTestFiles[0]
        );
        expect(standardPlan?.excludedFiles).toEqual(exclusiveStorybookTestFiles);
        expect(standardPlan?.testFiles).not.toContain(exclusiveStorybookTestFiles[0]);
        expect(executed.toSorted()).toEqual([...storyFiles].toSorted());
        expect(new Set(executed).size).toBe(executed.length);
    });

    test("creates one singleton group per exclusive file independent of input order", () => {
        const files = [
            "src/browser/a/A.stories.tsx",
            "src/browser/b/B.stories.tsx",
            "src/browser/c/C.stories.tsx",
            "src/browser/d/D.stories.tsx",
        ];
        const plans = createStorybookTestProjectPlan(files.toReversed(), [
            files[3] as string,
            files[1] as string,
        ]);

        expect(plans).toEqual([
            {
                excludedFiles: [files[0], files[2], files[3]],
                groupOrder: 0,
                name: "storybook-exclusive-001",
                testFiles: [files[1]],
            },
            {
                excludedFiles: [files[0], files[1], files[2]],
                groupOrder: 1,
                name: "storybook-exclusive-002",
                testFiles: [files[3]],
            },
            {
                excludedFiles: [files[1], files[3]],
                groupOrder: 2,
                name: "storybook",
                testFiles: [files[0], files[2]],
            },
        ]);
    });

    test("rejects unsafe or incomplete Storybook project ownership", () => {
        const standard = "src/browser/Standard.stories.tsx";
        const exclusive = "src/browser/Exclusive.stories.tsx";

        expect(() => createStorybookTestProjectPlan([], [])).toThrow(
            "contains no discovered stories"
        );
        expect(() =>
            createStorybookTestProjectPlan([standard, standard], [exclusive])
        ).toThrow("duplicate files");
        expect(() =>
            createStorybookTestProjectPlan([standard, exclusive], [exclusive, exclusive])
        ).toThrow("duplicate files");
        expect(() => createStorybookTestProjectPlan([standard], [exclusive])).toThrow(
            "missing from discovery"
        );
        for (const invalidPath of [
            "../Escape.stories.tsx",
            "/absolute/Story.stories.tsx",
            "src/browser/NotAStory.test.tsx",
            String.raw`src\browser\Windows.stories.tsx`,
        ]) {
            expect(() => createStorybookTestProjectPlan([invalidPath], [])).toThrow(
                "invalid story path"
            );
        }
        expect(() => createStorybookTestProjectPlan([exclusive], [exclusive])).toThrow(
            "requires at least one standard story file"
        );
    });

    test("parses complete successful Vitest JSON timings fail closed", () => {
        const files = ["a.stories.tsx", "b.stories.tsx"];
        const report = {
            numFailedTestSuites: 0,
            numFailedTests: 0,
            numPendingTestSuites: 0,
            numPendingTests: 0,
            numTodoTests: 0,
            success: true,
            testResults: files.map((filePath, index) => ({
                endTime: 1010.4 + index,
                name: path.join(projectRoot, filePath),
                startTime: 1000,
                status: "passed",
            })),
        };
        expect(parseStorybookTimingReport(report, files, projectRoot)).toEqual([
            { durationMs: 10, filePath: "a.stories.tsx" },
            { durationMs: 11, filePath: "b.stories.tsx" },
        ]);
        expect(
            parseStorybookTimingReport(
                {
                    ...report,
                    testResults: [
                        {
                            ...report.testResults[0],
                            endTime: 1000,
                        },
                    ],
                },
                ["a.stories.tsx"],
                projectRoot
            )
        ).toEqual([{ durationMs: 1, filePath: "a.stories.tsx" }]);
        expect(() =>
            parseStorybookTimingReport(
                {
                    ...report,
                    testResults: [
                        {
                            ...report.testResults[0],
                            endTime: undefined,
                        },
                    ],
                },
                ["a.stories.tsx"],
                projectRoot
            )
        ).toThrow("invalid result");
        expect(() =>
            parseStorybookTimingReport(
                {
                    ...report,
                    testResults: [
                        {
                            ...report.testResults[0],
                            endTime: Number.MAX_VALUE,
                            startTime: -Number.MAX_VALUE,
                        },
                    ],
                },
                ["a.stories.tsx"],
                projectRoot
            )
        ).toThrow("invalid duration");
        expect(() =>
            parseStorybookTimingReport({ ...report, success: false }, files, projectRoot)
        ).toThrow("successful run");
        expect(() =>
            parseStorybookTimingReport(
                { ...report, testResults: [report.testResults[0]] },
                files,
                projectRoot
            )
        ).toThrow("files missing from Storybook timing report");
        expect(() =>
            parseStorybookTimingReport(
                {
                    ...report,
                    testResults: [report.testResults[0], report.testResults[0]],
                },
                ["a.stories.tsx"],
                projectRoot
            )
        ).toThrow("duplicate Storybook timing report files");
        expect(() =>
            parseStorybookTimingReport(
                {
                    ...report,
                    testResults: [
                        {
                            ...report.testResults[0],
                            name: path.resolve(projectRoot, "../outside.stories.tsx"),
                        },
                    ],
                },
                ["a.stories.tsx"],
                projectRoot
            )
        ).toThrow("escapes the repository");
    });

    test("runs three complete count-capped batches sequentially", async () => {
        const commands: string[][] = [];
        const exitCode = await runStorybookTests(projectRoot, {
            runProcess: (command) => {
                commands.push([...command]);
                return Promise.resolve(0);
            },
        });
        const discovered = await discoverStorybookTestFiles(projectRoot);
        const projectPlans = createStorybookTestProjectPlan(discovered);
        const executed = commands.flatMap((command) => storyFilesFromCommand(command));

        expect(exitCode).toBe(0);
        expect(commands).toHaveLength(3);
        expect(
            commands.every((command) => command.includes("--maxWorkers=3"))
        ).toBeTrue();
        expect(commands.every((command) => command.includes("--no-isolate"))).toBeTrue();
        expect(
            commands.every((command) =>
                storybookTestProjectNames.every((name) =>
                    command.includes(`--project=${name}`)
                )
            )
        ).toBeTrue();
        for (const filePath of executed) {
            expect(
                projectPlans.filter(({ testFiles }) => testFiles.includes(filePath))
            ).toHaveLength(1);
        }
        expect(
            Math.max(
                ...commands
                    .map((command) => storyFilesFromCommand(command))
                    .map((files) => files.length)
            )
        ).toBe(30);
        expect(executed.toSorted()).toEqual([...discovered].toSorted());
        expect(new Set(executed).size).toBe(executed.length);
    });

    test("stops immediately when a Storybook batch fails", async () => {
        let calls = 0;
        expect(
            await runStorybookTests(projectRoot, {
                runProcess: () => Promise.resolve(++calls === 2 ? 19 : 0),
            })
        ).toBe(19);
        expect(calls).toBe(2);
    });

    test("atomically replaces stale and missing timings after every update batch passes", async () => {
        const discovered = await discoverStorybookTestFiles(projectRoot);
        const missingFile = discovered[0] as string;
        const timingsPath = await createTemporaryInventory({
            ...Object.fromEntries(
                discovered.slice(1).map((filePath, index) => [filePath, index + 1])
            ),
            "src/browser/deleted/Deleted.stories.tsx": 99_999,
        });
        const commands: readonly string[][] = [];

        expect(
            await runStorybookTests(projectRoot, {
                runProcess: async (command) => {
                    (commands as string[][]).push([...command]);
                    await writePassingTimingReport(command, (filePath) =>
                        filePath === missingFile ? 0 : 123
                    );
                    return 0;
                },
                timingsPath,
                updateTimings: true,
            })
        ).toBe(0);

        const updated = await readTestTimingsInventory(timingsPath, projectRoot);
        expect(commands).toHaveLength(3);
        expect(Object.keys(updated.files).toSorted()).toEqual([...discovered].toSorted());
        expect(updated.files[missingFile]).toBe(1);
        expect(updated.files["src/browser/deleted/Deleted.stories.tsx"]).toBeUndefined();
    });

    test("does not modify timings when a later update batch fails", async () => {
        const discovered = await discoverStorybookTestFiles(projectRoot);
        const timingsPath = await createTemporaryInventory(
            Object.fromEntries(discovered.map((filePath) => [filePath, 1]))
        );
        const before = await readFile(timingsPath, "utf8");
        let calls = 0;

        expect(
            await runStorybookTests(projectRoot, {
                runProcess: async (command) => {
                    calls += 1;
                    if (calls === 2) return 29;
                    await writePassingTimingReport(command);
                    return 0;
                },
                timingsPath,
                updateTimings: true,
            })
        ).toBe(29);
        expect(calls).toBe(2);
        expect(await readFile(timingsPath, "utf8")).toBe(before);
    });

    test("rejects malformed timing inventories before starting Vitest", async () => {
        const timingsPath = await createTemporaryInventory({});
        await writeFile(timingsPath, JSON.stringify({ files: [], version: 1 }));
        let calls = 0;
        expect(
            runStorybookTests(projectRoot, {
                runProcess: () => {
                    calls += 1;
                    return Promise.resolve(0);
                },
                timingsPath,
            })
        ).rejects.toThrow("Test timings must contain version 1 and a file map");
        expect(calls).toBe(0);
        expect(() =>
            parseTestTimingsInventory({ files: { "story.stories.tsx": -1 }, version: 1 })
        ).toThrow("Invalid test timing duration");
    });
});
