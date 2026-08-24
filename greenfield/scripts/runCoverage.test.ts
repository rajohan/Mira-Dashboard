import { describe, expect, test } from "bun:test";

import {
    type CoverageRunnerDependencies,
    createCoveragePartitionPlan,
    createCoverageTestArguments,
    runCoverage,
} from "./runCoverage.ts";

describe("coverage runner", () => {
    test("keeps Bun coverage free of browser globals", () => {
        expect(createCoverageTestArguments("/tmp/coverage-output", "bun")).toEqual([
            "--timings=.bun-test-timings.json",
            "--bail=1",
            "--only-failures",
            "--parallel=3",
            "--coverage",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/coverage-output",
            "scripts",
            "src/app",
            "src/contracts",
            "src/server",
            "src/shared",
            "src/test",
            "src/worker",
        ]);
    });

    test("runs browser coverage with three isolated workers", () => {
        expect(createCoverageTestArguments("/tmp/coverage-browser", "browser")).toEqual([
            "--timings=.bun-browser-test-timings.json",
            "--bail=1",
            "--only-failures",
            "--parallel=3",
            "--coverage",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/coverage-browser",
            "--preload",
            "./src/browser/test/setup.ts",
            "src/browser",
        ]);
    });

    test("runs and merges the two private LCOV inventories", async () => {
        const calls: string[][] = [];
        const mergedInventories: string[][] = [];
        const mergedPatterns: string[] = [];
        const writes: string[][] = [];
        const checks: string[][] = [];
        const logs: string[] = [];
        const dependencies: CoverageRunnerDependencies = {
            checkReport: (...arguments_) => {
                checks.push(arguments_.map(String));
                return Promise.resolve({
                    foundLines: 20,
                    hitLines: 18,
                    percent: 90,
                });
            },
            coverageDirectory: "/tmp/coverage",
            log: (message) => logs.push(message),
            mergeReports: (reportPaths, reportPattern) => {
                mergedInventories.push([...reportPaths]);
                mergedPatterns.push(reportPattern);
                return Promise.resolve("TN:\nend_of_record");
            },
            projectRoot: "/tmp/project",
            resetDirectory: (directory) => {
                calls.push(["reset", directory]);
                return Promise.resolve();
            },
            runTests: (arguments_, receivedProjectRoot) => {
                calls.push(["test", ...arguments_, receivedProjectRoot]);
                return Promise.resolve(0);
            },
            writeReport: (filePath, coverage) => {
                writes.push([filePath, coverage]);
                return Promise.resolve();
            },
        };

        expect(await runCoverage(dependencies)).toBe(0);

        const plans = createCoveragePartitionPlan("/tmp/coverage");
        expect(calls).toEqual([
            ["reset", "/tmp/coverage"],
            ...plans.map((plan) => [
                "test",
                ...createCoverageTestArguments(plan.outputDirectory, plan.name),
                "/tmp/project",
            ]),
        ]);
        expect(mergedInventories).toEqual([plans.map((plan) => plan.reportPath)]);
        expect(mergedPatterns).toEqual(["/tmp/coverage/*/lcov.info"]);
        expect(writes).toEqual([["/tmp/coverage/lcov.info", "TN:\nend_of_record"]]);
        expect(checks).toHaveLength(1);
        expect(checks[0]).toEqual([
            "/tmp/coverage/lcov.info",
            "85",
            "scripts,src,drizzle.config.ts,tailwind.config.ts",
            "/tmp/project",
        ]);
        expect(logs).toEqual(["Coverage 90.00% meets required 85.00% (18/20 lines)"]);
    });

    test("stops before browser coverage and merge after a Bun failure", async () => {
        const testCalls: string[][] = [];
        let mergeCalls = 0;
        const dependencies: CoverageRunnerDependencies = {
            checkReport: () => {
                return Promise.reject(new Error("coverage policy must not run"));
            },
            coverageDirectory: "/tmp/coverage",
            log: () => {
                throw new Error("coverage summary must not be logged");
            },
            mergeReports: () => {
                mergeCalls += 1;
                return Promise.resolve("");
            },
            projectRoot: "/tmp/project",
            resetDirectory: () => Promise.resolve(),
            runTests: (arguments_) => {
                testCalls.push([...arguments_]);
                return Promise.resolve(23);
            },
            writeReport: () => {
                return Promise.reject(new Error("coverage report must not be written"));
            },
        };

        expect(await runCoverage(dependencies)).toBe(23);
        expect(testCalls).toHaveLength(1);
        expect(mergeCalls).toBe(0);
    });
});
