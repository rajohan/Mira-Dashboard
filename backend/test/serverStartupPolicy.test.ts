import { describe, expect, it } from "bun:test";

describe("server start scheduler policy", () => {
    it("starts scheduled jobs unless explicitly disabled", async () => {
        const { shouldStartScheduledJobs } = await import("../src/serverStartPolicy.ts");

        expect(shouldStartScheduledJobs({})).toBe(true);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "0",
            })
        ).toBe(true);
        expect(
            shouldStartScheduledJobs({
                MIRA_DASHBOARD_DISABLE_SCHEDULER: "1",
            })
        ).toBe(false);
    });
});
