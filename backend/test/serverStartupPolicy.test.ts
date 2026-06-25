import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, jest } from "bun:test";

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

    it("starts and stops the backend server with isolated runtime state", async () => {
        const environmentKeys = [
            "MIRA_DASHBOARD_DB_PATH",
            "MIRA_DASHBOARD_DISABLE_SCHEDULER",
            "MIRA_DASHBOARD_FRONTEND_PATH",
            "OPENCLAW_HOME",
        ] as const;
        const originalEnvironment = Object.fromEntries(
            environmentKeys.map((key) => [key, process.env[key]])
        );
        const temporaryRoot = mkdtempSync(path.join(tmpdir(), "mira-server-start-"));
        const frontendRoot = path.join(temporaryRoot, "frontend");
        const openclawRoot = path.join(temporaryRoot, "openclaw");
        mkdirSync(frontendRoot, { recursive: true });
        mkdirSync(openclawRoot, { recursive: true });
        writeFileSync(path.join(frontendRoot, "index.html"), "<!doctype html>");
        writeFileSync(path.join(openclawRoot, "openclaw.json"), "{}\n");

        process.env.MIRA_DASHBOARD_DB_PATH = path.join(temporaryRoot, "dashboard.db");
        process.env.MIRA_DASHBOARD_DISABLE_SCHEDULER = "1";
        process.env.MIRA_DASHBOARD_FRONTEND_PATH = frontendRoot;
        process.env.OPENCLAW_HOME = openclawRoot;
        const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
        const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
        try {
            const { startBackendServer, stopBackendServer } =
                await import("../src/serverStart.ts");

            startBackendServer(0);
            startBackendServer(0);
            await stopBackendServer();
            await stopBackendServer();
        } finally {
            errorSpy.mockRestore();
            warnSpy.mockRestore();
            for (const key of environmentKeys) {
                const originalValue = originalEnvironment[key];
                if (originalValue === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = originalValue;
                }
            }
            rmSync(temporaryRoot, { force: true, recursive: true });
        }
    });

});
