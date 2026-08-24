import { describe, expect, test } from "bun:test";

import { createCoverageTestArguments } from "./runCoverage.ts";

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

    test("loads the DOM setup only for browser coverage", () => {
        const arguments_ = createCoverageTestArguments("/tmp/coverage-output", "browser");

        expect(arguments_).toEqual([
            "--coverage",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/coverage-output",
            "--preload",
            "./src/browser/test/setup.ts",
            "src/browser",
        ]);
    });
});
