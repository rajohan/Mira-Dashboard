import { describe, expect, test } from "bun:test";

import { createCoverageTestArguments } from "./runCoverage.ts";

describe("coverage runner", () => {
    test("keeps Bun coverage free of browser globals", () => {
        const arguments_ = createCoverageTestArguments("/tmp/coverage-output", "bun");

        expect(arguments_).toEqual([
            "--reporter",
            "dots",
            "--coverage",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/coverage-output",
            "--path-ignore-patterns",
            "src/browser/**",
            "scripts",
            "src",
        ]);
    });

    test("loads the DOM setup only for browser coverage", () => {
        const arguments_ = createCoverageTestArguments("/tmp/coverage-output", "browser");

        expect(arguments_).toEqual([
            "--reporter",
            "dots",
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
