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

    it("resolves backend startup entrypoint and gateway token decisions without starting services", async () => {
        const { isDirectEntrypoint, resolveGatewayToken, shouldStartOnImport } =
            await import("../src/serverStart.ts");

        expect(
            resolveGatewayToken(
                {
                    OPENCLAW_GATEWAY_TOKEN: " gateway-token ",
                    OPENCLAW_TOKEN: "legacy-token",
                },
                () => "persisted-token"
            )
        ).toBe("gateway-token");
        expect(
            resolveGatewayToken(
                { OPENCLAW_TOKEN: " legacy-token " },
                () => "persisted-token"
            )
        ).toBe("legacy-token");
        expect(resolveGatewayToken({}, () => " persisted-token ")).toBe(
            "persisted-token"
        );
        expect(resolveGatewayToken({}, () => "")).toBeUndefined();

        expect(
            isDirectEntrypoint("/tmp/serverStart.ts", "file:///tmp/serverStart.ts")
        ).toBe(true);
        expect(isDirectEntrypoint("/tmp/other.ts", "file:///tmp/serverStart.ts")).toBe(
            false
        );
        expect(isDirectEntrypoint(undefined, "file:///tmp/serverStart.ts")).toBe(false);

        expect(shouldStartOnImport("1", false)).toBe(true);
        expect(shouldStartOnImport(undefined, true)).toBe(true);
        expect(shouldStartOnImport("0", false)).toBe(false);
    });
});
