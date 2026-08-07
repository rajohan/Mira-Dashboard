import { describe, expect, test } from "bun:test";

import { createCoverageTestArguments } from "./runCoverage.ts";

describe("coverage runner", () => {
    test("runs every test target in one coverage process without a global DOM", () => {
        const arguments_ = createCoverageTestArguments("/tmp/coverage-output");

        expect(arguments_).toEqual([
            "--coverage",
            "--coverage-reporter",
            "text",
            "--coverage-reporter",
            "lcov",
            "--coverage-dir",
            "/tmp/coverage-output",
            "scripts",
            "src",
        ]);
    });
});
