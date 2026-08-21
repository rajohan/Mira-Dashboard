import { describe, expect, test } from "bun:test";
import path from "node:path";

import {
    assertExactCoverageArtifactInventory,
    assertStorybookProductionCoverageSources,
    type CoverageRunnerDependencies,
    type CoverageTestInventories,
    createCoveragePartitionPlan,
    createCoverageTestArguments,
    createCoverageTestCommand,
    loadCoverageTestInventories,
    normalizeMergedLineCoverage,
    normalizeStorybookProductionCoverage,
    parseCoverageRunMode,
    runCoverage,
    selectCoveragePartitionPlans,
} from "./runCoverage.ts";
import { storybookTestProjectNames } from "./storybookTestProjects.ts";
import type { TimedTestFile } from "./testBatching.ts";

const projectRoot = path.resolve(import.meta.dir, "..");

function createTimedTests(prefix: string, suffix = ".test.ts"): readonly TimedTestFile[] {
    return Object.freeze(
        Array.from({ length: 6 }, (_, index) => ({
            durationMs: (index + 1) * 10,
            filePath: `${prefix}/fixture-${index}${suffix}`,
        }))
    );
}

const sampleInventories: CoverageTestInventories = Object.freeze({
    browser: createTimedTests("src/browser"),
    bun: createTimedTests("src/worker"),
    storybook: createTimedTests("src/browser/ui/stories", ".stories.tsx"),
});
const samplePlans = createCoveragePartitionPlan("/tmp/coverage", sampleInventories);
const sampleReportPaths = Object.freeze(samplePlans.map(({ reportPath }) => reportPath));

describe("coverage runner", () => {
    test("removes incomparable Storybook branch records from merged line coverage", () => {
        expect(
            normalizeMergedLineCoverage(
                [
                    "TN:",
                    "SF:src/example.ts",
                    "DA:10,4",
                    "BRDA:10,0,0,0",
                    "BRDA:10,0,1,4",
                    "BRF:2",
                    "BRH:1",
                    "LF:1",
                    "LH:1",
                    "end_of_record",
                ].join("\n")
            )
        ).toBe(
            ["TN:", "SF:src/example.ts", "DA:10,4", "LF:1", "LH:1", "end_of_record"].join(
                "\n"
            )
        );
    });

    test("discovers exact current inventories and creates nine complete batches", async () => {
        const inventories = await loadCoverageTestInventories(projectRoot);
        expect(inventories.bun).toHaveLength(509);
        expect(inventories.browser).toHaveLength(192);
        expect(inventories.storybook).toHaveLength(89);

        const plans = createCoveragePartitionPlan("/tmp/coverage", inventories);
        expect(plans.map(({ name }) => name)).toEqual([
            "bun-001",
            "bun-002",
            "bun-003",
            "browser-001",
            "browser-002",
            "browser-003",
            "storybook-001",
            "storybook-002",
            "storybook-003",
        ]);
        expect(plans.filter(({ partition }) => partition === "bun")).toHaveLength(3);
        expect(plans.filter(({ partition }) => partition === "browser")).toHaveLength(3);
        expect(plans.filter(({ partition }) => partition === "storybook")).toHaveLength(
            3
        );
        expect(
            new Set(
                plans
                    .filter(({ partition }) => partition === "bun")
                    .flatMap(({ testFiles }) => testFiles)
            ).size
        ).toBe(509);
        expect(
            new Set(
                plans
                    .filter(({ partition }) => partition === "browser")
                    .flatMap(({ testFiles }) => testFiles)
            ).size
        ).toBe(192);
        expect(
            new Set(
                plans
                    .filter(({ partition }) => partition === "storybook")
                    .flatMap(({ testFiles }) => testFiles)
            ).size
        ).toBe(89);
    });

    test("keeps timing scheduling and exact parallel-3 in every child", () => {
        const bunArguments = createCoverageTestArguments("/tmp/bun", "bun", [
            "src/worker/a.test.ts",
        ]);
        expect(bunArguments).toEqual([
            "--timings=.bun-test-timings.json",
            "--bail=1",
            "--only-failures",
            "--parallel=3",
            "--no-isolate",
            "--coverage",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/bun",
            "src/worker/a.test.ts",
        ]);
        expect(
            createCoverageTestArguments("/tmp/browser", "browser", [
                "src/browser/a.test.ts",
            ])
        ).toEqual([
            "--timings=.bun-browser-test-timings.json",
            "--bail=1",
            "--only-failures",
            "--parallel=3",
            "--no-isolate",
            "--coverage",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/browser",
            "--preload",
            "./src/browser/test/setup.ts",
            "src/browser/a.test.ts",
        ]);
        expect(() => createCoverageTestArguments("/tmp/bun", "bun", [])).toThrow(
            "Coverage batch requires explicit test files"
        );
        expect(() =>
            createCoverageTestArguments("/tmp/storybook", "storybook", [
                "src/browser/ui/stories/Badge.stories.tsx",
            ])
        ).toThrow("Vitest command adapter");

        const storybookPlan = createCoveragePartitionPlan(
            "/tmp/coverage",
            sampleInventories
        ).find(({ partition }) => partition === "storybook");
        expect(storybookPlan).toBeDefined();
        const storybookCommand = createCoverageTestCommand(
            "/tmp/dashboard",
            storybookPlan as NonNullable<typeof storybookPlan>
        );
        expect(storybookCommand.slice(0, 11)).toEqual([
            process.execPath,
            "/tmp/dashboard/node_modules/vitest/vitest.mjs",
            "run",
            "--config",
            ".storybook/vitest.config.ts",
            "--bail=1",
            "--project=storybook-exclusive-001",
            "--project=storybook",
            "--maxWorkers=3",
            "--no-isolate",
            "--coverage",
        ]);
        expect(
            storybookCommand
                .filter((argument) => argument.startsWith("--project="))
                .map((argument) => argument.slice("--project=".length))
        ).toEqual(storybookTestProjectNames);
        expect(storybookCommand).toContain("--coverage.provider=v8");
        expect(storybookCommand).toContain("--coverage.reporter=lcov");
        expect(storybookCommand).toContain(
            "--coverage.reportsDirectory=/tmp/coverage/storybook-001"
        );
        expect(storybookCommand).toContain(
            "--coverage.exclude=src/browser/storySupport/**"
        );
    });

    test("selects only one exact three-batch partition and rejects ambiguous CLI input", () => {
        expect(parseCoverageRunMode([])).toBe("all");
        expect(parseCoverageRunMode(["--merge"])).toBe("merge");
        for (const partition of ["bun", "browser", "storybook"] as const) {
            expect(parseCoverageRunMode([`--partition=${partition}`])).toBe(partition);
            expect(
                selectCoveragePartitionPlans(samplePlans, partition).map(
                    ({ name }) => name
                )
            ).toEqual([`${partition}-001`, `${partition}-002`, `${partition}-003`]);
        }
        for (const arguments_ of [
            ["--partition=worker"],
            ["--merge", "--partition=bun"],
            ["bun"],
        ]) {
            expect(() => parseCoverageRunMode(arguments_)).toThrow(
                "Coverage arguments must be empty"
            );
        }
        expect(() => selectCoveragePartitionPlans(samplePlans.slice(1), "bun")).toThrow(
            "requires exactly 3 batches"
        );
    });

    test("runs each CI partition as only its exact three shared plans", async () => {
        for (const partition of ["bun", "browser", "storybook"] as const) {
            const selectedPlans = selectCoveragePartitionPlans(samplePlans, partition);
            const commands: string[][] = [];
            const validatedReports: string[] = [];
            let resets = 0;
            const dependencies: CoverageRunnerDependencies = {
                checkReport: () =>
                    Promise.reject(new Error("partition must not check coverage")),
                coverageDirectory: "/tmp/coverage",
                listArtifacts: () =>
                    Promise.resolve(selectedPlans.map(({ reportPath }) => reportPath)),
                loadTests: () => Promise.resolve(sampleInventories),
                log: () => {
                    throw new Error("partition must not log aggregate coverage");
                },
                mergeReports: () =>
                    Promise.reject(new Error("partition must not merge coverage")),
                projectRoot: "/tmp/project",
                resetDirectory: () => {
                    resets += 1;
                    return Promise.resolve();
                },
                runCommand: (command) => {
                    commands.push([...command]);
                    return Promise.resolve(0);
                },
                validateStorybookReport: (reportPath) => {
                    validatedReports.push(reportPath);
                    return Promise.resolve();
                },
                writeReport: () =>
                    Promise.reject(new Error("partition must not write merged coverage")),
            };

            expect(await runCoverage(dependencies, partition)).toBe(0);
            expect(resets).toBe(1);
            expect(commands).toEqual(
                selectedPlans.map((plan) =>
                    createCoverageTestCommand("/tmp/project", plan)
                )
            );
            expect(validatedReports).toEqual(
                partition === "storybook"
                    ? selectedPlans.map(({ reportPath }) => reportPath)
                    : []
            );
        }
    });

    test("merge-only revalidates Storybook and applies one aggregate policy", async () => {
        const events: string[] = [];
        const validatedReports: string[] = [];
        const dependencies: CoverageRunnerDependencies = {
            checkReport: (reportPath, threshold, roots, root) => {
                events.push(
                    `check:${reportPath}:${threshold}:${roots.join(",")}:${root}`
                );
                return Promise.resolve({ foundLines: 20, hitLines: 18, percent: 90 });
            },
            coverageDirectory: "/tmp/coverage",
            listArtifacts: () => {
                events.push("inventory");
                return Promise.resolve(sampleReportPaths);
            },
            loadTests: () => Promise.resolve(sampleInventories),
            log: (message) => events.push(`log:${message}`),
            mergeReports: (reportPaths) => {
                events.push(`merge:${reportPaths.join(",")}`);
                return Promise.resolve("TN:\nend_of_record");
            },
            projectRoot: "/tmp/project",
            resetDirectory: () =>
                Promise.reject(new Error("merge must preserve downloaded artifacts")),
            runCommand: () => Promise.reject(new Error("merge must not run tests")),
            validateStorybookReport: (reportPath) => {
                validatedReports.push(reportPath);
                return Promise.resolve();
            },
            writeReport: (reportPath, contents) => {
                events.push(`write:${reportPath}:${contents}`);
                return Promise.resolve();
            },
        };

        expect(await runCoverage(dependencies, "merge")).toBe(0);
        expect(validatedReports).toEqual(
            selectCoveragePartitionPlans(samplePlans, "storybook").map(
                ({ reportPath }) => reportPath
            )
        );
        expect(events).toEqual([
            "inventory",
            `merge:${sampleReportPaths.join(",")}`,
            "write:/tmp/coverage/lcov.info:TN:\nend_of_record",
            "check:/tmp/coverage/lcov.info:85:scripts,src,drizzle.config.ts,tailwind.config.ts:/tmp/project",
            "log:Coverage 90.00% meets required 85.00% (18/20 lines)",
        ]);
    });

    test("merge fails closed on missing, duplicate, and stale LCOV artifacts", async () => {
        const stalePath = "/tmp/coverage/stale/lcov.info";
        const cases = [
            {
                artifacts: sampleReportPaths.slice(1),
                finding: "missing:\nbun-001/lcov.info",
            },
            {
                artifacts: [...sampleReportPaths, sampleReportPaths[0] as string],
                finding: "duplicate:\nbun-001/lcov.info",
            },
            {
                artifacts: [...sampleReportPaths, stalePath],
                finding: "unexpected:\nstale/lcov.info",
            },
        ] as const;

        for (const { artifacts, finding } of cases) {
            let downstreamCalls = 0;
            const dependencies: CoverageRunnerDependencies = {
                checkReport: () => {
                    downstreamCalls += 1;
                    return Promise.resolve({ foundLines: 1, hitLines: 1, percent: 100 });
                },
                coverageDirectory: "/tmp/coverage",
                listArtifacts: () => Promise.resolve(artifacts),
                loadTests: () => Promise.resolve(sampleInventories),
                log: () => {
                    downstreamCalls += 1;
                },
                mergeReports: () => {
                    downstreamCalls += 1;
                    return Promise.resolve("");
                },
                projectRoot: "/tmp/project",
                resetDirectory: () =>
                    Promise.reject(new Error("merge must not reset artifacts")),
                runCommand: () => Promise.reject(new Error("merge must not run tests")),
                validateStorybookReport: () => {
                    downstreamCalls += 1;
                    return Promise.resolve();
                },
                writeReport: () => {
                    downstreamCalls += 1;
                    return Promise.resolve();
                },
            };

            const result = await runCoverage(dependencies, "merge").catch(
                (error: unknown) => error
            );
            expect(result).toBeInstanceOf(Error);
            expect((result as Error).message).toContain(finding);
            expect(downstreamCalls).toBe(0);
        }

        expect(() =>
            assertExactCoverageArtifactInventory("/tmp/coverage", sampleReportPaths, [
                "/tmp/outside/lcov.info",
            ])
        ).toThrow("escapes its private directory");
    });

    test("runs sequentially and merges all nine LCOV reports explicitly", async () => {
        const events: string[] = [];
        const testCalls: string[][] = [];
        const mergeCalls: string[][] = [];
        const validatedReports: string[] = [];
        let active = false;
        const dependencies: CoverageRunnerDependencies = {
            checkReport: () =>
                Promise.resolve({ foundLines: 20, hitLines: 18, percent: 90 }),
            coverageDirectory: "/tmp/coverage",
            listArtifacts: () => Promise.resolve(sampleReportPaths),
            loadTests: () => Promise.resolve(sampleInventories),
            log: (message) => events.push(`log:${message}`),
            mergeReports: (reportPaths, reportPattern) => {
                events.push("merge");
                mergeCalls.push([...reportPaths, reportPattern]);
                return Promise.resolve("TN:\nend_of_record");
            },
            projectRoot: "/tmp/project",
            resetDirectory: () => {
                events.push("reset");
                return Promise.resolve();
            },
            runCommand: async (arguments_) => {
                expect(active).toBeFalse();
                active = true;
                await Promise.resolve();
                testCalls.push([...arguments_]);
                events.push("test");
                active = false;
                return 0;
            },
            validateStorybookReport: (reportPath) => {
                validatedReports.push(reportPath);
                events.push("validate");
                return Promise.resolve();
            },
            writeReport: (filePath, coverage) => {
                events.push(`write:${filePath}:${coverage}`);
                return Promise.resolve();
            },
        };

        expect(await runCoverage(dependencies)).toBe(0);
        expect(testCalls).toHaveLength(9);
        expect(
            testCalls.every(
                (call) =>
                    call.includes("--parallel=3") !== call.includes("--maxWorkers=3")
            )
        ).toBeTrue();
        expect(testCalls.every((call) => call.includes("--no-isolate"))).toBeTrue();
        expect(testCalls.every((call) => call.includes("--bail=1"))).toBeTrue();
        const plans = createCoveragePartitionPlan("/tmp/coverage", sampleInventories);
        expect(validatedReports).toEqual(
            plans
                .filter(({ partition }) => partition === "storybook")
                .map(({ reportPath }) => reportPath)
        );
        expect(mergeCalls).toEqual([
            [...plans.map(({ reportPath }) => reportPath), "/tmp/coverage/*/lcov.info"],
        ]);
        expect(events).toEqual([
            "reset",
            "test",
            "test",
            "test",
            "test",
            "test",
            "test",
            "test",
            "validate",
            "test",
            "validate",
            "test",
            "validate",
            "merge",
            "write:/tmp/coverage/lcov.info:TN:\nend_of_record",
            "log:Coverage 90.00% meets required 85.00% (18/20 lines)",
        ]);
    });

    test("stops immediately after a failed middle batch", async () => {
        let testCalls = 0;
        let mergeCalls = 0;
        const dependencies: CoverageRunnerDependencies = {
            checkReport: () => Promise.reject(new Error("coverage policy must not run")),
            coverageDirectory: "/tmp/coverage",
            listArtifacts: () => Promise.reject(new Error("inventory must not run")),
            loadTests: () => Promise.resolve(sampleInventories),
            log: () => {
                throw new Error("coverage summary must not be logged");
            },
            mergeReports: () => {
                mergeCalls += 1;
                return Promise.resolve("");
            },
            projectRoot: "/tmp/project",
            resetDirectory: () => Promise.resolve(),
            runCommand: () => {
                testCalls += 1;
                return Promise.resolve(testCalls === 4 ? 23 : 0);
            },
            validateStorybookReport: () =>
                Promise.reject(new Error("Storybook validation must not run")),
            writeReport: () =>
                Promise.reject(new Error("coverage report must not be written")),
        };

        expect(await runCoverage(dependencies)).toBe(23);
        expect(testCalls).toBe(4);
        expect(mergeCalls).toBe(0);
    });

    test("clears stale coverage before inventory loading fails", async () => {
        let resets = 0;
        const dependencies: CoverageRunnerDependencies = {
            checkReport: () => Promise.reject(new Error("coverage policy must not run")),
            coverageDirectory: "/tmp/coverage",
            listArtifacts: () => Promise.reject(new Error("inventory must not run")),
            loadTests: () => Promise.reject(new Error("stale timing inventory")),
            log: () => {
                throw new Error("coverage summary must not be logged");
            },
            mergeReports: () => Promise.reject(new Error("merge must not run")),
            projectRoot: "/tmp/project",
            resetDirectory: () => {
                resets += 1;
                return Promise.resolve();
            },
            runCommand: () => Promise.reject(new Error("tests must not run")),
            validateStorybookReport: () =>
                Promise.reject(new Error("validation must not run")),
            writeReport: () => Promise.reject(new Error("report must not be written")),
        };

        const error = await runCoverage(dependencies).catch((error: unknown) => error);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe("stale timing inventory");
        expect(resets).toBe(1);
    });

    test("rejects non-production Storybook LCOV before aggregate merging", () => {
        expect(() =>
            assertStorybookProductionCoverageSources(
                ["SF:src/browser/ui/Badge.tsx", "LF:3", "LH:3", "end_of_record"].join(
                    "\n"
                )
            )
        ).not.toThrow();
        for (const sourcePath of [
            ".storybook/preview.tsx",
            "src/browser/ui/stories/Badge.stories.tsx",
            "src/browser/storySupport/dashboardPageStoryHarness.tsx",
            "src/browser/ui/Badge.test.tsx",
            "src/browser/../../outside.ts",
            "src/server/private.ts",
            "../outside.ts",
        ]) {
            expect(() =>
                assertStorybookProductionCoverageSources(
                    `SF:${sourcePath}\nLF:1\nLH:1\nend_of_record`
                )
            ).toThrow("non-production source records");
        }
        expect(() => assertStorybookProductionCoverageSources("TN:\n")).toThrow(
            "malformed source record"
        );
    });

    test("removes only Vitest V8's exact empty source sentinel", () => {
        const emptySentinel = [
            "TN:",
            "SF:",
            "FNF:0",
            "FNH:0",
            "LF:0",
            "LH:0",
            "BRF:0",
            "BRH:0",
            "end_of_record",
        ].join("\n");
        const productionRecord = [
            "TN:",
            "SF:src/browser/ui/Badge.tsx",
            "LF:3",
            "LH:3",
            "end_of_record",
        ].join("\n");

        expect(
            normalizeStorybookProductionCoverage(
                `${emptySentinel}\n${productionRecord}\n`
            )
        ).toBe(`${productionRecord}\n`);
        expect(() =>
            normalizeStorybookProductionCoverage(emptySentinel.replace("LF:0", "LF:1"))
        ).toThrow("non-production source records");
        expect(() => normalizeStorybookProductionCoverage(emptySentinel)).toThrow(
            "no production source records"
        );
    });
});
