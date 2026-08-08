import { describe, expect, test } from "bun:test";

import {
    type CoverageRunnerDependencies,
    createCoveragePartitionPlan,
    createCoverageTestArguments,
    runCoverage,
} from "./runCoverage.ts";

const isolatedBrowserCoverageCases = Object.freeze([
    Object.freeze({
        outputDirectory: "/tmp/coverage-schedule-detail-form",
        partition: "browser-schedule-detail-form",
        testPath: "src/browser/jobs/ScheduleDetailForm.test.tsx",
    }),
    Object.freeze({
        outputDirectory: "/tmp/coverage-schedule-detail-state-disable",
        partition: "browser-schedule-detail-state-disable",
        testPath: "src/browser/jobs/ScheduleDetailStateDisable.test.tsx",
    }),
    Object.freeze({
        outputDirectory: "/tmp/coverage-schedule-detail-state-errors",
        partition: "browser-schedule-detail-state-errors",
        testPath: "src/browser/jobs/ScheduleDetailStateErrors.test.tsx",
    }),
    Object.freeze({
        outputDirectory: "/tmp/coverage-schedule-detail-state-version",
        partition: "browser-schedule-detail-state-version",
        testPath: "src/browser/jobs/ScheduleDetailStateVersion.test.tsx",
    }),
    Object.freeze({
        outputDirectory: "/tmp/coverage-schedule-detail-state-copy",
        partition: "browser-schedule-detail-state-copy",
        testPath: "src/browser/jobs/ScheduleDetailStateCopy.test.tsx",
    }),
    Object.freeze({
        outputDirectory: "/tmp/coverage-schedule-detail-state-replay",
        partition: "browser-schedule-detail-state-replay",
        testPath: "src/browser/jobs/ScheduleDetailStateReplay.test.tsx",
    }),
] as const);

describe("coverage runner", () => {
    test("keeps Bun coverage free of browser globals", () => {
        const arguments_ = createCoverageTestArguments("/tmp/coverage-output", "bun");

        expect(arguments_).toEqual([
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

    test("uses the shared deterministic policy for every browser shard", () => {
        expect(createCoverageTestArguments("/tmp/coverage-core", "browser-core")).toEqual(
            [
                "--coverage",
                "--coverage-reporter",
                "lcov",
                "--coverage-dir",
                "/tmp/coverage-core",
                "--preload",
                "./src/browser/test/setup.ts",
                "--max-concurrency=1",
                "--bail=1",
                "--path-ignore-patterns=src/browser/jobs/**",
                "src/browser",
            ]
        );
        expect(createCoverageTestArguments("/tmp/coverage-jobs", "browser-jobs")).toEqual(
            [
                "--coverage",
                "--coverage-reporter",
                "lcov",
                "--coverage-dir",
                "/tmp/coverage-jobs",
                "--preload",
                "./src/browser/test/setup.ts",
                "--max-concurrency=1",
                "--bail=1",
                "--path-ignore-patterns=src/browser/jobs/{ScheduleDetailForm.test.tsx,ScheduleDetailStateDisable.test.tsx,ScheduleDetailStateErrors.test.tsx,ScheduleDetailStateVersion.test.tsx,ScheduleDetailStateCopy.test.tsx,ScheduleDetailStateReplay.test.tsx}",
                "src/browser/jobs",
            ]
        );
        for (const testCase of isolatedBrowserCoverageCases) {
            expect(
                createCoverageTestArguments(testCase.outputDirectory, testCase.partition)
            ).toEqual([
                "--coverage",
                "--coverage-reporter",
                "lcov",
                "--coverage-dir",
                testCase.outputDirectory,
                "--preload",
                "./src/browser/test/setup.ts",
                "--max-concurrency=1",
                "--bail=1",
                testCase.testPath,
            ]);
        }
    });

    test("runs and merges the nine private LCOV inventories", async () => {
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
        expect(checks[0]?.[0]).toBe("/tmp/coverage/lcov.info");
        expect(logs).toEqual(["Coverage 90.00% meets required 85.00% (18/20 lines)"]);
    });

    test("stops before later shards and merge after a test failure", async () => {
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
                return Promise.resolve(testCalls.length === 2 ? 23 : 0);
            },
            writeReport: () => {
                return Promise.reject(new Error("coverage report must not be written"));
            },
        };

        expect(await runCoverage(dependencies)).toBe(23);
        expect(testCalls).toHaveLength(2);
        expect(mergeCalls).toBe(0);
    });
});
