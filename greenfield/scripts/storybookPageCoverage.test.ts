import { describe, expect, test } from "bun:test";

import { dashboardRouteDocumentation } from "../src/shared/browserRouteRegistry.ts";
import { dashboardPageStoryRequirements } from "./storybookPageCoverage.ts";

const projectRoot = `${import.meta.dir}/..`;

describe("full-page Storybook coverage", () => {
    test("keeps every production route and material state in the page-story inventory", async () => {
        expect(dashboardPageStoryRequirements.map(({ path }) => path).toSorted()).toEqual(
            dashboardRouteDocumentation.map(({ path }) => path).toSorted()
        );
        for (const requirement of dashboardPageStoryRequirements) {
            const source = await Bun.file(`${projectRoot}/${requirement.file}`).text();
            expect(source).toContain(`title: "${requirement.title}"`);
            expect(source).toMatch(/component:\s*DashboardPageStory\b/u);
            expect(source).toMatch(
                new RegExp(`(?:route=|route:)\\s*["']${requirement.path}["']`, "u")
            );
            for (const exportName of requirement.exports) {
                expect(source).toMatch(
                    new RegExp(`export\\s+const\\s+${exportName}\\b`, "u")
                );
            }
        }
    });
});
