import assert from "node:assert/strict";
import http from "node:http";
import { after, before, describe, it } from "node:test";

import express from "express";

import gateway from "../gateway.js";
import openClawConfigRoutes from "./openclawConfig.js";

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalRequest = gateway.request;

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    openClawConfigRoutes(app);
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

describe("OpenClaw config routes", () => {
    let server: TestServer;
    const calls: Array<{ method: string; params: unknown }> = [];
    let configHash: string | undefined = "hash-123";

    before(async () => {
        gateway.request = async (method: string, params?: unknown) => {
            calls.push({ method, params });

            if (method === "config.get") {
                return {
                    hash: configHash,
                    parsed: {
                        model: "codex",
                        skills: {
                            entries: {
                                "custom-skill": {
                                    enabled: false,
                                    description: "Custom skill from config",
                                },
                            },
                        },
                    },
                };
            }

            if (method === "config.patch") {
                return { patched: true, params };
            }

            throw new Error(`Unexpected gateway method: ${method}`);
        };
        server = await startServer();
    });

    after(async () => {
        await server.close();
        gateway.request = originalRequest;
    });

    it("returns config snapshots with the OpenClaw hash", async () => {
        const response = await requestJson<{
            model: string;
            __hash: string;
        }>(server, "/api/config");

        assert.equal(response.status, 200);
        assert.equal(response.body.model, "codex");
        assert.equal(response.body.__hash, "hash-123");
    });

    it("patches config with base hash and dashboard note", async () => {
        calls.length = 0;

        const response = await requestJson<{ ok: true; result: { patched: true } }>(
            server,
            "/api/config",
            { method: "PUT", body: { model: "kimi" } }
        );

        assert.equal(response.status, 200);
        assert.equal(response.body.ok, true);
        assert.deepEqual(calls, [
            { method: "config.get", params: {} },
            {
                method: "config.patch",
                params: {
                    raw: JSON.stringify({ model: "kimi" }),
                    baseHash: "hash-123",
                    note: "Updated from Mira Dashboard settings",
                },
            },
        ]);
    });

    it("fails config writes when OpenClaw hash is unavailable", async () => {
        configHash = undefined;
        const response = await requestJson<{ error: string }>(server, "/api/config", {
            method: "PUT",
            body: { model: "kimi" },
        });
        configHash = "hash-123";

        assert.equal(response.status, 500);
        assert.equal(response.body.error, "OpenClaw config hash unavailable");
    });

    it("lists configured skills and toggles skill state through config.patch", async () => {
        const skillsResponse = await requestJson<{
            skills: Array<{
                name: string;
                path: string;
                enabled: boolean;
                description?: string;
                source: string;
            }>;
        }>(server, "/api/skills");

        assert.equal(skillsResponse.status, 200);
        const customSkill = skillsResponse.body.skills.find(
            (skill) => skill.name === "custom-skill"
        );
        assert.deepEqual(customSkill, {
            name: "custom-skill",
            path: "skills.entries.custom-skill",
            enabled: false,
            description: "Custom skill from config",
            source: "extra",
        });

        calls.length = 0;
        const toggle = await requestJson<{ ok: true }>(
            server,
            "/api/skills/custom-skill",
            {
                method: "POST",
                body: { enabled: true },
            }
        );

        assert.equal(toggle.status, 200);
        assert.equal(toggle.body.ok, true);
        assert.deepEqual(calls.at(-1), {
            method: "config.patch",
            params: {
                raw: JSON.stringify({
                    skills: { entries: { "custom-skill": { enabled: true } } },
                }),
                baseHash: "hash-123",
                note: "Updated from Mira Dashboard settings",
            },
        });
    });

    it("creates config backups from current snapshots", async () => {
        const response = await requestJson<{
            createdAt: string;
            hash: string;
            config: { model: string };
        }>(server, "/api/backup", { method: "POST" });

        assert.equal(response.status, 200);
        assert.match(response.body.createdAt, /^\d{4}-\d{2}-\d{2}T/u);
        assert.equal(response.body.hash, "hash-123");
        assert.equal(response.body.config.model, "codex");
    });
});
