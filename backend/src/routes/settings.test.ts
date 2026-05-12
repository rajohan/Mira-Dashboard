import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import express from "express";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

async function startServer(homeDir: string): Promise<TestServer> {
    process.env.HOME = homeDir;
    const { default: settingsRoutes } = await import("./settings.js");

    const app = express();
    app.use(express.json());
    settingsRoutes(app, express, () => ({ gateway: "connected", sessions: 3 }));
    const server = http.createServer(app);

    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");

    return {
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
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
    });

    it("validates settings updates before writing them", async () => {
        const invalidTheme = await requestJson<{ error: string }>(
            server,
            "/api/settings",
            { method: "PUT", body: { theme: "solarized" } }
        );
        assert.equal(invalidTheme.status, 400);
        assert.equal(invalidTheme.body.error, "Invalid theme");

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
});
