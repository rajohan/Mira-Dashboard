import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    assertCoverageIncludesSources,
    assertLineCoverage,
    discoverExecutableCoverageSources,
    summarizeLineCoverage,
} from "./checkCoverage.ts";
import {
    parseChangedLines,
    selectPatchCoverageBase,
    summarizePatchCoverage,
} from "./checkPatchCoverage.ts";
import { temporaryProject } from "./sourceBoundaries/testSupport.ts";

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
    test("selects explicit, GitHub, and stacked local bases without flattening features", () => {
        expect(
            selectPatchCoverageBase(
                { MIRA_DASHBOARD_COVERAGE_BASE: "refs/heads/review-base" },
                "feature",
                "origin/stack-parent"
            )
        ).toBe("refs/heads/review-base");
        expect(
            selectPatchCoverageBase(
                { GITHUB_BASE_REF: "stack-parent" },
                "feature",
                undefined
            )
        ).toBe("origin/stack-parent");
        expect(selectPatchCoverageBase({}, "feature", "origin/stack-parent")).toBe(
            "origin/stack-parent"
        );
        expect(selectPatchCoverageBase({}, "main", undefined)).toBe("origin/main");
        expect(() => selectPatchCoverageBase({}, "feature", undefined)).toThrow(
            "Coverage base is unknown"
        );
    });
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

    test("excludes Storybook sources from production totals", () => {
        const summary = summarizeLineCoverage(
            [
                record("src/server/service.ts", 80, 70),
                record("src/shared/value.ts", 20, 15),
                record("src/browser/ui/Button.stories.tsx", 100, 100),
                record("src/browser/storySupport/providers.tsx", 100, 100),
            ].join("\n"),
            ["src"]
        );

        expect(summary).toEqual({ foundLines: 100, hitLines: 85, percent: 85 });
    });

    test("excludes Storybook sources from the executable production inventory", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "src", "shared"));
            await mkdir(path.join(projectRoot, "src", "browser", "storySupport"));
            await writeFile(
                path.join(projectRoot, "src", "shared", "production.ts"),
                "export const production = true;"
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "Button.stories.tsx"),
                "export const Story = {};"
            );
            await writeFile(
                path.join(projectRoot, "src", "browser", "storySupport", "providers.tsx"),
                "export const providers = true;"
            );

            expect(await discoverExecutableCoverageSources(projectRoot, ["src"])).toEqual(
                ["src/shared/production.ts"]
            );
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("includes exact executable root configurations without treating them as directories", async () => {
        const projectRoot = await temporaryProject();
        try {
            await Promise.all([
                writeFile(
                    path.join(projectRoot, "drizzle.config.ts"),
                    "export default { dialect: 'sqlite' };"
                ),
                writeFile(
                    path.join(projectRoot, "tailwind.config.ts"),
                    "export default { plugins: [] };"
                ),
            ]);

            expect(
                await discoverExecutableCoverageSources(projectRoot, [
                    "scripts",
                    "src",
                    "drizzle.config.ts",
                    "tailwind.config.ts",
                ])
            ).toEqual(["drizzle.config.ts", "tailwind.config.ts"]);
            expect(
                summarizeLineCoverage(
                    [
                        record("drizzle.config.ts", 2, 1),
                        record("drizzle.config.ts/injected.ts", 100, 100),
                        record("tailwind.config.ts", 2, 1),
                        record("tailwind.config.ts/injected.ts", 100, 100),
                    ].join("\n"),
                    ["drizzle.config.ts", "tailwind.config.ts"]
                )
            ).toEqual({ foundLines: 4, hitLines: 2, percent: 50 });
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("excludes script test support without hiding similarly named production files", async () => {
        const projectRoot = await temporaryProject();
        try {
            await mkdir(path.join(projectRoot, "scripts", "nested", "testSupport"), {
                recursive: true,
            });
            await Promise.all([
                writeFile(
                    path.join(projectRoot, "scripts", "productionTestSupport.ts"),
                    "export const production = true;"
                ),
                writeFile(
                    path.join(projectRoot, "scripts", "testSupport.ts"),
                    "export const fixture = true;"
                ),
                writeFile(
                    path.join(
                        projectRoot,
                        "scripts",
                        "nested",
                        "testSupport",
                        "fixture.ts"
                    ),
                    "export const nestedFixture = true;"
                ),
            ]);

            expect(
                await discoverExecutableCoverageSources(projectRoot, ["scripts"])
            ).toEqual(["scripts/productionTestSupport.ts"]);
        } finally {
            await rm(projectRoot, { force: true, recursive: true });
        }
    });

    test("keeps Bun coverage from counting test support, stories and story support", async () => {
        const bunfig = await Bun.file(new URL("../bunfig.toml", import.meta.url)).text();

        expect(bunfig).toContain('"scripts/**/testSupport/**"');
        expect(bunfig).toContain('"scripts/**/testSupport.ts"');
        expect(bunfig).toContain('"scripts/**/testSupport.tsx"');
        expect(bunfig).toContain('"src/**/*.stories.tsx"');
        expect(bunfig).toContain('"src/**/storySupport/**"');
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

    test("measures only executable lines added by a zero-context Git diff", () => {
        const changed = parseChangedLines(
            [
                "diff --git a/src/service.ts b/src/service.ts",
                "+++ b/src/service.ts",
                "@@ -3,0 +4,3 @@",
                "+const comment = true;",
                "+covered();",
                "+missed();",
                "diff --git a/scripts/tool.ts b/scripts/tool.ts",
                "+++ b/scripts/tool.ts",
                "@@ -0,0 +1 @@",
                "+run();",
            ].join("\n")
        );
        expect([...changed.get("src/service.ts")!]).toEqual([4, 5, 6]);
        const summary = summarizePatchCoverage(
            [
                "SF:src/service.ts",
                "DA:5,2",
                "DA:6,0",
                "end_of_record",
                "SF:scripts/tool.ts",
                "DA:1,1",
                "end_of_record",
            ].join("\n"),
            changed,
            "/checkout"
        );
        expect(summary.foundLines).toBe(3);
        expect(summary.hitLines).toBe(2);
        expect(summary.percent).toBeCloseTo(200 / 3);
    });

    test("normalizes absolute LCOV source paths for patch coverage", () => {
        const changed = new Map([["src/service.ts", new Set([7])]]);
        expect(
            summarizePatchCoverage(
                "SF:/checkout/src/service.ts\nDA:7,1\nend_of_record",
                changed,
                "/checkout"
            )
        ).toEqual({ foundLines: 1, hitLines: 1, percent: 100 });
    });
});
