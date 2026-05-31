import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(
    homeDir: string,
    getGatewayStatus = () => ({ gateway: "connected", sessions: 3 })
): Promise<TestServer> {
    const originalHome = process.env.HOME;
    process.env.HOME = homeDir;
    try {
        const { default: settingsRoutes } = await import("./settings.js");

        const app = express();
        app.use(express.json());
        settingsRoutes(app, express, getGatewayStatus);
        const server = http.createServer(app);

        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error) => {
                server.off("listening", onListening);
                server.close();
                reject(error);
            };
            const onListening = () => {
                server.off("error", onError);
                resolve();
            };
            server.once("error", onError);
            server.once("listening", onListening);
            server.listen(0);
        });
        const address = server.address();
        assert.ok(address && typeof address === "object");

        return {
            baseUrl: `http://127.0.0.1:${address.port}`,
            close: () =>
                new Promise((resolve) =>
                    server.close(() => {
                        if (originalHome === undefined) {
                            delete process.env.HOME;
                        } else {
                            process.env.HOME = originalHome;
                        }
                        resolve();
                    })
                ),
        };
    } catch (error) {
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        throw error;
    }
}

async function requestJson<T>(
    server: TestServer,
    pathName: string,
    options: { method?: string; body?: unknown } = {}
): Promise<{ status: number; body: T }> {
    const response = await fetch(`${server.baseUrl}${pathName}`, {
        method: options.method || "GET",
        headers:
            options.body === undefined
                ? undefined
                : { "Content-Type": "application/json" },
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });

    return {
        status: response.status,
        body: (await response.json()) as T,
    };
}

describe("settings routes", () => {
    let server: TestServer;
    let homeDir: string;
    let settingsPath: string;

    before(async () => {
        homeDir = await mkdtemp(path.join(os.tmpdir(), "mira-settings-route-"));
        settingsPath = path.join(homeDir, ".openclaw", "dashboard-settings.json");
        server = await startServer(homeDir);
    });

    after(async () => {
        await server.close();
        await rm(homeDir, { recursive: true, force: true });
    });

    it("returns defaults with gateway status when no settings file exists", async () => {
        const { __testing } = await import("./settings.js");
        assert.equal(
            __testing.resolveSettingsDir("/tmp/settings-home"),
            path.join("/tmp/settings-home", ".openclaw")
        );
        assert.equal(
            __testing.resolveSettingsDir(""),
            path.join(os.homedir(), ".openclaw")
        );
        assert.equal(
            __testing.resolveSettingsDir("   "),
            path.join(os.homedir(), ".openclaw")
        );
        assert.equal(
            __testing.resolveSettingsDir(),
            path.join(os.homedir(), ".openclaw")
        );
        const originalHome = process.env.HOME;
        try {
            delete process.env.HOME;
            assert.equal(
                __testing.resolveSettingsDir(),
                path.join(os.homedir(), ".openclaw")
            );
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
        }

        const response = await requestJson<{
            theme: string;
            sidebarCollapsed: boolean;
            defaultModel: string;
            refreshInterval: number;
            gateway: { gateway: string; sessions: number };
        }>(server, "/api/settings");

        assert.equal(response.status, 200);
        assert.equal(response.body.theme, "dark");
        assert.equal(response.body.sidebarCollapsed, false);
        assert.equal(response.body.defaultModel, "ollama/glm-5");
        assert.equal(response.body.refreshInterval, 5000);
        assert.deepEqual(response.body.gateway, { gateway: "connected", sessions: 3 });
    });

    it("merges, persists, and reloads settings", async () => {
        const alternateHome = await mkdtemp(path.join(os.tmpdir(), "mira-settings-alt-"));
        const updated = await requestJson<{
            theme: string;
            sidebarCollapsed: boolean;
            defaultModel: string;
            refreshInterval: number;
        }>(server, "/api/settings", {
            method: "PUT",
            body: { theme: "system", sidebarCollapsed: true },
        });

        assert.equal(updated.status, 200);
        assert.equal(updated.body.theme, "system");
        assert.equal(updated.body.sidebarCollapsed, true);
        assert.equal(updated.body.defaultModel, "ollama/glm-5");

        const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
            string,
            unknown
        >;
        assert.equal(saved.theme, "system");
        assert.equal(saved.sidebarCollapsed, true);

        const reloaded = await requestJson<{ theme: string; sidebarCollapsed: boolean }>(
            server,
            "/api/settings"
        );

        assert.equal(reloaded.body.theme, "system");
        assert.equal(reloaded.body.sidebarCollapsed, true);

        const originalHome = process.env.HOME;
        try {
            process.env.HOME = alternateHome;
            const alternate = await requestJson<{
                theme: string;
                sidebarCollapsed: boolean;
            }>(server, "/api/settings");
            assert.equal(alternate.body.theme, "dark");

            const alternateUpdate = await requestJson<{ theme: string }>(
                server,
                "/api/settings",
                {
                    method: "PUT",
                    body: { theme: "light" },
                }
            );
            assert.equal(alternateUpdate.status, 200);
            assert.equal(
                JSON.parse(
                    await readFile(
                        path.join(alternateHome, ".openclaw", "dashboard-settings.json"),
                        "utf8"
                    )
                ).theme,
                "light"
            );
        } finally {
            if (originalHome === undefined) {
                delete process.env.HOME;
            } else {
                process.env.HOME = originalHome;
            }
            await rm(alternateHome, { recursive: true, force: true });
        }
    });

    it("validates settings updates before writing them", async () => {
        const invalidTheme = await requestJson<{ error: string }>(
            server,
            "/api/settings",
            { method: "PUT", body: { theme: "solarized" } }
        );
        assert.equal(invalidTheme.status, 400);
        assert.equal(invalidTheme.body.error, "Invalid theme");

        const invalidPayload = await requestJson<{ error: string }>(
            server,
            "/api/settings",
            { method: "PUT", body: [] }
        );
        assert.equal(invalidPayload.status, 400);
        assert.equal(invalidPayload.body.error, "Settings payload must be an object");

        const invalidSidebar = await requestJson<{ error: string }>(
            server,
            "/api/settings",
            { method: "PUT", body: { sidebarCollapsed: "yes" } }
        );
        assert.equal(invalidSidebar.status, 400);
        assert.equal(invalidSidebar.body.error, "Invalid sidebarCollapsed setting");

        const invalidModel = await requestJson<{ error: string }>(
            server,
            "/api/settings",
            { method: "PUT", body: { defaultModel: "" } }
        );
        assert.equal(invalidModel.status, 400);
        assert.equal(invalidModel.body.error, "Invalid defaultModel setting");

        const invalidRefreshInterval = await requestJson<{ error: string }>(
            server,
            "/api/settings",
            { method: "PUT", body: { refreshInterval: null } }
        );
        assert.equal(invalidRefreshInterval.status, 400);
        assert.equal(
            invalidRefreshInterval.body.error,
            "Invalid refreshInterval setting"
        );

        const clamped = await requestJson<{
            defaultModel: string;
            refreshInterval: number;
        }>(server, "/api/settings", {
            method: "PUT",
            body: { defaultModel: " codex ", refreshInterval: 500_000 },
        });
        assert.equal(clamped.status, 200);
        assert.equal(clamped.body.defaultModel, "codex");
        assert.equal(clamped.body.refreshInterval, 60_000);

        const saved = JSON.parse(await readFile(settingsPath, "utf8")) as Record<
            string,
            unknown
        >;
        assert.equal(saved.defaultModel, "codex");
        assert.equal(saved.refreshInterval, 60_000);
    });

    it("falls back to defaults when the settings file is malformed", async () => {
        await writeFile(settingsPath, "not json", "utf8");
        const originalError = console.error;
        console.error = () => {};

        try {
            const response = await requestJson<{
                theme: string;
                refreshInterval: number;
            }>(server, "/api/settings");

            assert.equal(response.status, 200);
            assert.equal(response.body.theme, "dark");
            assert.equal(response.body.refreshInterval, 5000);
        } finally {
            console.error = originalError;
        }
    });

    it("falls back to defaults when persisted settings values are invalid", async () => {
        await writeFile(
            settingsPath,
            JSON.stringify({ theme: 42, refreshInterval: "oops" }),
            "utf8"
        );

        const response = await requestJson<{
            theme: string;
            refreshInterval: number;
        }>(server, "/api/settings");

        assert.equal(response.status, 200);
        assert.equal(response.body.theme, "dark");
        assert.equal(response.body.refreshInterval, 5000);
    });

    it("reports gateway-status and save failures", async () => {
        const failingHomeDir = await mkdtemp(
            path.join(os.tmpdir(), "mira-settings-failing-")
        );
        const gatewayFailure = await startServer(failingHomeDir, () => {
            throw new Error("gateway status failed");
        });
        try {
            const getResponse = await requestJson<{ error: string }>(
                gatewayFailure,
                "/api/settings"
            );
            assert.equal(getResponse.status, 500);
            assert.equal(getResponse.body.error, "gateway status failed");
        } finally {
            await gatewayFailure.close();
        }

        await rm(settingsPath, { recursive: true, force: true });
        await mkdir(settingsPath, { recursive: true });
        const originalError = console.error;
        console.error = () => {};
        try {
            const putResponse = await requestJson<{ error: string }>(
                server,
                "/api/settings",
                { method: "PUT", body: { theme: "light" } }
            );
            assert.equal(putResponse.status, 500);
            assert.equal(putResponse.body.error, "Failed to save settings");
        } finally {
            console.error = originalError;
            await rm(settingsPath, { recursive: true, force: true });
            await rm(failingHomeDir, { recursive: true, force: true });
        }
    });
});
