import { describe, expect, test } from "bun:test";

import {
    assertCoverageIncludesSources,
    assertLineCoverage,
    summarizeLineCoverage,
} from "./checkCoverage.ts";

function record(source: string, foundLines: number, hitLines: number): string {
    return [
        "TN:",
        `SF:${source}`,
        `LF:${String(foundLines)}`,
        `LH:${String(hitLines)}`,
        "end_of_record",
    ].join("\n");
}

describe("coverage threshold", () => {
    test("aggregates only exact selected source roots", () => {
        const summary = summarizeLineCoverage(
            [
                record("src/server/service.ts", 80, 70),
                record("src/shared/value.ts", 20, 15),
                record("src-old/ignored.ts", 100, 0),
                record("scripts/ignored.ts", 100, 0),
            ].join("\n"),
            ["src"]
        );

        expect(summary).toEqual({ foundLines: 100, hitLines: 85, percent: 85 });
    });

    test("accepts the exact threshold and rejects a lower result", () => {
        const exact = record("src/service.ts", 100, 85);
        expect(assertLineCoverage(exact, 85, ["src"]).percent).toBe(85);

        expect(() =>
            assertLineCoverage(record("src/service.ts", 100, 84), 85, ["src"])
        ).toThrow("Coverage 84.00% is below required 85.00% (84/100 lines)");
    });

    test("rejects missing and internally inconsistent line totals", () => {
        expect(() => summarizeLineCoverage("TN:\n", ["src"])).toThrow(
            "LCOV contains no line coverage"
        );
        expect(() =>
            summarizeLineCoverage("SF:src/service.ts\nLF:2\nLH:3\nend_of_record\n", [
                "src",
            ])
        ).toThrow("LCOV hit-line total exceeds");
        expect(() =>
            summarizeLineCoverage(
                "SF:src/service.ts\nLF:not-a-number\nLH:0\nend_of_record\n",
                ["src"]
            )
        ).toThrow("LCOV contains an invalid LF line count");
    });

    test("requires a valid threshold and repository-relative source root", () => {
        const lcov = record("src/service.ts", 1, 1);
        expect(() => assertLineCoverage(lcov, Number.NaN, ["src"])).toThrow(
            "Coverage threshold must be between zero and 100"
        );
        expect(() => summarizeLineCoverage(lcov, [])).toThrow(
            "Coverage requires at least one repository source root"
        );
        expect(() => summarizeLineCoverage(lcov, ["../src"])).toThrow(
            "Coverage requires at least one repository source root"
        );
        expect(() => summarizeLineCoverage(lcov, ["/src"])).toThrow(
            "Coverage requires at least one repository source root"
        );
    });

    test("rejects an executable source file missing entirely from LCOV", () => {
        const lcov = record("src/service.ts", 10, 10);
        expect(() =>
            assertCoverageIncludesSources(lcov, ["src/missing.ts", "src/service.ts"])
        ).toThrow("LCOV is missing executable source files:\nsrc/missing.ts");

        expect(() =>
            assertCoverageIncludesSources(lcov, ["src/service.ts"])
        ).not.toThrow();
    });
});
