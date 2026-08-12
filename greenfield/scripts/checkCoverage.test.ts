import { describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
    assertCoverageIncludesSources,
    assertLineCoverage,
    discoverExecutableCoverageSources,
    summarizeLineCoverage,
} from "./checkCoverage.ts";
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
});
