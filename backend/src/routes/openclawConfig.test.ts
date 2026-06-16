import assert from "node:assert/strict";
import fs from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it, mock } from "node:test";

import express from "express";

import gateway from "../gateway.js";
import openClawConfigRoutes, { __testing } from "./openclawConfig.js";

function compareStrings(left: string, right: string): number {
    return left === right ? 0 : left > right ? 1 : -1;
}

interface TestServer {
    baseUrl: string;
    close: () => Promise<void>;
}

const originalRequest = gateway.request;

async function withTempSkills(
    callback: (context: {
        tempDir: string;
        packageRoot: string;
        homeDir: string;
    }) => Promise<void> | void
): Promise<void> {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-skills-"));
    const packageRoot = path.join(tempDir, "package-root");
    const homeDir = path.join(tempDir, "home");
    try {
        await callback({ tempDir, packageRoot, homeDir });
    } finally {
        await rm(tempDir, { recursive: true, force: true });
    }
}

async function withSkillEnvironment(
    packageRoot: string,
    homeDir: string,
    callback: () => Promise<void> | void
): Promise<void> {
    const originalHome = process.env.HOME;
    const originalUserProfile = process.env.USERPROFILE;
    const originalPackageRootEnv = process.env.OPENCLAW_PACKAGE_ROOT;
    try {
        process.env.HOME = homeDir;
        process.env.USERPROFILE = homeDir;
        __testing.setOpenClawPackageRootForTest(packageRoot);
        await callback();
    } finally {
        __testing.setOpenClawPackageRootForTest(undefined);
        if (originalPackageRootEnv === undefined) {
            delete process.env.OPENCLAW_PACKAGE_ROOT;
        } else {
            process.env.OPENCLAW_PACKAGE_ROOT = originalPackageRootEnv;
        }
        if (originalHome === undefined) {
            delete process.env.HOME;
        } else {
            process.env.HOME = originalHome;
        }
        if (originalUserProfile === undefined) {
            delete process.env.USERPROFILE;
        } else {
            process.env.USERPROFILE = originalUserProfile;
        }
    }
}

async function startServer(): Promise<TestServer> {
    const app = express();
    app.use(express.json());
    openClawConfigRoutes(app);
    const server = http.createServer(app);

    await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
            server.off("listening", onListening);
            server.off("error", onError);
        };
        const onListening = () => {
            cleanup();
            resolve();
        };
        const onError = (error: Error) => {
            cleanup();
            reject(error);
        };

        server.once("listening", onListening);
        server.once("error", onError);
        server.listen(0);
    });
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
        try {
            if (server) {
                await server.close();
            }
        } finally {
            gateway.request = originalRequest;
        }
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

        calls.length = 0;
        const invalid = await requestJson<{ error: string }>(server, "/api/config", {
            method: "PUT",
            body: ["not", "an", "object"],
        });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, "Invalid config: expected JSON object");
        assert.deepEqual(calls, []);
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

        calls.length = 0;
        const trimmedToggle = await requestJson<{ ok: true }>(
            server,
            "/api/skills/%20custom-skill%20",
            {
                method: "POST",
                body: { enabled: false },
            }
        );
        assert.equal(trimmedToggle.status, 200);
        assert.deepEqual(calls.at(-1), {
            method: "config.patch",
            params: {
                raw: JSON.stringify({
                    skills: { entries: { "custom-skill": { enabled: false } } },
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

        const previousRequest = gateway.request;
        try {
            gateway.request = async (method: string) => {
                if (method === "config.get") {
                    return { hash: "hash-empty" };
                }
                throw new Error(`Unexpected gateway method: ${method}`);
            };
            const emptyConfig = await requestJson<{
                hash: string;
                config: Record<string, unknown>;
            }>(server, "/api/backup", { method: "POST" });
            assert.equal(emptyConfig.status, 200);
            assert.equal(emptyConfig.body.hash, "hash-empty");
            assert.deepEqual(emptyConfig.body.config, {});
        } finally {
            gateway.request = previousRequest;
        }
    });

    it("parses skill descriptions", async () => {
        await withTempSkills(async ({ tempDir }) => {
            const fallbackSkill = path.join(tempDir, "fallback-skill");
            const describedSkill = path.join(tempDir, "described-skill");
            await mkdir(fallbackSkill, { recursive: true });
            await mkdir(describedSkill, { recursive: true });
            await writeFile(
                path.join(fallbackSkill, "SKILL.md"),
                "---\n---\n# Title\nFirst useful line\n",
                "utf8"
            );
            await writeFile(
                path.join(describedSkill, "SKILL.md"),
                "description: 'Quoted description'\n",
                "utf8"
            );

            assert.equal(
                __testing.readSkillDescription(fallbackSkill),
                "First useful line"
            );
            assert.equal(
                __testing.readSkillDescription(describedSkill),
                "Quoted description"
            );
            assert.equal(
                __testing.readSkillDescription(path.join(tempDir, "missing")),
                undefined
            );
        });
    });

    it("collects skill directories", async () => {
        await withTempSkills(async ({ tempDir }) => {
            const fallbackSkill = path.join(tempDir, "fallback-skill");
            const describedSkill = path.join(tempDir, "described-skill");
            await mkdir(fallbackSkill, { recursive: true });
            await mkdir(describedSkill, { recursive: true });
            await writeFile(path.join(tempDir, "README.md"), "Not a skill\n", "utf8");
            await writeFile(path.join(fallbackSkill, "SKILL.md"), "Fallback\n", "utf8");
            await writeFile(path.join(describedSkill, "SKILL.md"), "Described\n", "utf8");

            assert.deepEqual(
                __testing
                    .collectSkillDirectories(tempDir)
                    .map((skillPath) => path.basename(skillPath))
                    .sort(compareStrings),
                ["described-skill", "fallback-skill"]
            );
            assert.deepEqual(
                __testing.collectSkillDirectories(path.join(tempDir, "missing")),
                []
            );
        });
    });

    it("collects extra skill directories and tolerates extension scan failures", async () => {
        await withTempSkills(async ({ packageRoot, homeDir }) => {
            const extensionSkill = path.join(
                packageRoot,
                "dist/extensions/example/skills/extra-skill"
            );
            await mkdir(path.join(packageRoot, "dist/extensions"), { recursive: true });
            await writeFile(
                path.join(packageRoot, "dist/extensions/README.md"),
                "Not an extension\n",
                "utf8"
            );
            await mkdir(extensionSkill, { recursive: true });
            await writeFile(
                path.join(extensionSkill, "SKILL.md"),
                "Extra skill\n",
                "utf8"
            );

            await withSkillEnvironment(packageRoot, homeDir, () => {
                const originalPackageRootEnv = process.env.OPENCLAW_PACKAGE_ROOT;
                try {
                    process.env.OPENCLAW_PACKAGE_ROOT = packageRoot;
                    __testing.setOpenClawPackageRootForTest(undefined);
                    assert.equal(__testing.getOpenClawPackageRootForTest(), packageRoot);
                } finally {
                    if (originalPackageRootEnv === undefined) {
                        delete process.env.OPENCLAW_PACKAGE_ROOT;
                    } else {
                        process.env.OPENCLAW_PACKAGE_ROOT = originalPackageRootEnv;
                    }
                    __testing.setOpenClawPackageRootForTest(packageRoot);
                }

                assert.deepEqual(
                    __testing
                        .collectExtraSkillDirectories()
                        .map((skillPath) => path.basename(skillPath)),
                    ["extra-skill"]
                );

                const originalReaddirSync = fs.readdirSync;
                const readdirMock = mock.method(
                    fs,
                    "readdirSync",
                    (root: fs.PathLike) => {
                        if (String(root).includes("dist/extensions")) {
                            throw new Error("extensions unavailable");
                        }
                        return originalReaddirSync(root, {
                            withFileTypes: true,
                        }) as unknown as ReturnType<typeof fs.readdirSync>;
                    }
                );
                try {
                    assert.deepEqual(__testing.collectExtraSkillDirectories(), []);
                } finally {
                    readdirMock.mock.restore();
                }
            });
        });
    });

    it("merges configured and discovered skills", async () => {
        await withTempSkills(async ({ packageRoot, homeDir }) => {
            const packageSkill = path.join(packageRoot, "skills", "builtin-skill");
            const extensionSkill = path.join(
                packageRoot,
                "dist/extensions/example/skills/extra-skill"
            );
            const workspaceSkill = path.join(
                homeDir,
                ".openclaw/workspace/skills/workspace-skill"
            );
            const unconfiguredSkill = path.join(
                homeDir,
                ".openclaw/workspace/skills/unconfigured-skill"
            );
            await mkdir(packageSkill, { recursive: true });
            await mkdir(extensionSkill, { recursive: true });
            await mkdir(workspaceSkill, { recursive: true });
            await mkdir(unconfiguredSkill, { recursive: true });
            await writeFile(
                path.join(packageSkill, "SKILL.md"),
                "Builtin skill\n",
                "utf8"
            );
            await writeFile(
                path.join(extensionSkill, "SKILL.md"),
                "Extra skill\n",
                "utf8"
            );
            await writeFile(
                path.join(workspaceSkill, "SKILL.md"),
                "Workspace skill\n",
                "utf8"
            );
            await writeFile(
                path.join(unconfiguredSkill, "SKILL.md"),
                "Unconfigured skill\n",
                "utf8"
            );

            await withSkillEnvironment(packageRoot, homeDir, () => {
                const entries = __testing.getConfiguredSkillEntries({
                    skills: {
                        entries: {
                            "fallback-skill": { enabled: false },
                            "configured-only": { description: "Configured only" },
                        },
                    },
                });
                assert.deepEqual(Object.keys(entries).sort(compareStrings), [
                    "configured-only",
                    "fallback-skill",
                ]);

                const skills = __testing.getSkills({
                    skills: {
                        entries: {
                            "configured-only": {
                                enabled: false,
                                description: "Configured only",
                            },
                            "workspace-skill": {
                                enabled: false,
                                description: "Should not replace discovered skill",
                            },
                            "builtin-skill": {
                                enabled: false,
                                description: "Should not replace built-in skill",
                            },
                            "extra-skill": {
                                enabled: false,
                                description: "Should not replace extension skill",
                            },
                        },
                    },
                });
                assert.equal(
                    skills.some(
                        (skill) =>
                            skill.name === "workspace-skill" &&
                            skill.enabled === false &&
                            skill.description === "Should not replace discovered skill" &&
                            skill.source === "workspace"
                    ),
                    true
                );
                assert.equal(
                    skills.some(
                        (skill) =>
                            skill.name === "unconfigured-skill" &&
                            skill.enabled === true &&
                            skill.description === "Unconfigured skill" &&
                            skill.source === "workspace"
                    ),
                    true
                );
                assert.equal(
                    skills.some(
                        (skill) =>
                            skill.name === "builtin-skill" &&
                            skill.enabled === false &&
                            skill.source === "builtin"
                    ),
                    true
                );
                assert.equal(
                    skills.some(
                        (skill) =>
                            skill.name === "extra-skill" &&
                            skill.enabled === false &&
                            skill.source === "extra"
                    ),
                    true
                );
                assert.equal(
                    skills.some(
                        (skill) =>
                            skill.name === "configured-only" &&
                            skill.enabled === false &&
                            skill.source === "extra"
                    ),
                    true
                );
            });
        });
    });

    it("handles configured skill entry edge cases", () => {
        assert.deepEqual(__testing.getConfiguredSkillEntries(), {});
        assert.deepEqual(
            __testing.getConfiguredSkillEntries({ skills: { entries: [] } }),
            {}
        );
        assert.deepEqual(__testing.getConfiguredSkillEntries({ skills: "invalid" }), {});
        assert.equal(
            __testing
                .getSkills({
                    skills: {
                        entries: {
                            "primitive-entry": "enabled",
                        },
                    },
                })
                .some(
                    (skill) =>
                        skill.name === "primitive-entry" &&
                        skill.enabled === true &&
                        skill.description === ""
                ),
            true
        );
    });

    it("validates skill names", () => {
        assert.equal(__testing.isValidSkillName("ok-skill"), true);
        assert.equal(__testing.isValidSkillName(""), false);
        assert.equal(__testing.isValidSkillName("x".repeat(129)), false);
        assert.equal(__testing.isValidSkillName("bad/name"), false);
        assert.equal(__testing.isValidSkillName(String.raw`bad\name`), false);
        assert.equal(__testing.isValidSkillName("__proto__"), false);
        assert.equal(__testing.isValidSkillName("prototype"), false);
        assert.equal(__testing.isValidSkillName("constructor"), false);
    });

    it("reports config, skills, backup, restart, and skill toggle errors", async () => {
        const originalRequest = gateway.request;
        gateway.request = async () => {
            throw new Error("gateway failed");
        };

        try {
            const config = await requestJson<{ error: string }>(server, "/api/config");
            assert.equal(config.status, 500);
            assert.equal(config.body.error, "gateway failed");
            const skills = await requestJson<{ error: string }>(server, "/api/skills");
            assert.equal(skills.status, 500);
            assert.equal(skills.body.error, "gateway failed");
            const backup = await requestJson<{ error: string }>(server, "/api/backup", {
                method: "POST",
            });
            assert.equal(backup.status, 500);
            assert.equal(backup.body.error, "gateway failed");
            const invalidName = await requestJson<{ error: string }>(
                server,
                "/api/skills/bad%2Fname",
                {
                    method: "POST",
                    body: { enabled: true },
                }
            );
            assert.equal(invalidName.status, 400);
            assert.equal(invalidName.body.error, "Invalid skill name");
            const invalidEnabled = await requestJson<{ error: string }>(
                server,
                "/api/skills/custom-skill",
                {
                    method: "POST",
                    body: { enabled: "yes" },
                }
            );
            assert.equal(invalidEnabled.status, 400);
            assert.equal(invalidEnabled.body.error, "Invalid enabled value");
            const nullBody = await requestJson<{ error: string }>(
                server,
                "/api/skills/custom-skill",
                {
                    method: "POST",
                }
            );
            assert.equal(nullBody.status, 400);
            assert.equal(nullBody.body.error, "Invalid enabled value");
            const toggleFailure = await requestJson<{ error: string }>(
                server,
                "/api/skills/custom-skill",
                {
                    method: "POST",
                    body: { enabled: true },
                }
            );
            assert.equal(toggleFailure.status, 500);
            assert.equal(toggleFailure.body.error, "gateway failed");
        } finally {
            gateway.request = originalRequest;
        }
    });

    it("runs restart through an injected OpenClaw binary", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-bin-"));
        try {
            const binPath = path.join(tempDir, "openclaw");
            await writeFile(
                binPath,
                `#!${process.execPath}
process.exit(0);
`,
                "utf8"
            );
            await chmod(binPath, 0o755);
            __testing.setOpenClawBinForTest(binPath);

            const restart = await requestJson<{ ok: boolean }>(server, "/api/restart", {
                method: "POST",
            });

            assert.equal(restart.status, 200);
            assert.deepEqual(restart.body, { ok: true });

            const failingBinPath = path.join(tempDir, "openclaw-fail");
            await writeFile(
                failingBinPath,
                `#!${process.execPath}
throw new Error("restart failed");
`,
                "utf8"
            );
            await chmod(failingBinPath, 0o755);
            __testing.setOpenClawBinForTest(failingBinPath);

            const failedRestart = await requestJson<{ error: string }>(
                server,
                "/api/restart",
                { method: "POST" }
            );

            assert.equal(failedRestart.status, 500);
            assert.match(failedRestart.body.error, /Command failed/u);
        } finally {
            __testing.setOpenClawBinForTest(undefined);
            await rm(tempDir, { recursive: true, force: true });
        }
        try {
            __testing.setOpenClawBinForTest("");
            assert.equal(__testing.getOpenClawBinForTest(), "");
            __testing.setOpenClawBinForTest(undefined);
            assert.equal(
                __testing.getOpenClawBinForTest(),
                process.env.OPENCLAW_BIN ||
                    path.join(os.homedir(), ".npm-global/bin/openclaw")
            );
        } finally {
            __testing.setOpenClawBinForTest(undefined);
        }
    });

    it("reads OpenClaw environment defaults lazily", async () => {
        const tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-env-"));
        const originalPackageRootEnv = process.env.OPENCLAW_PACKAGE_ROOT;
        const originalBinEnv = process.env.OPENCLAW_BIN;
        try {
            const envPackageRoot = path.join(tempDir, "env-package-root");
            const envBin = path.join(tempDir, "openclaw-env");
            process.env.OPENCLAW_PACKAGE_ROOT = envPackageRoot;
            process.env.OPENCLAW_BIN = envBin;
            __testing.setOpenClawPackageRootForTest(undefined);
            __testing.setOpenClawBinForTest(undefined);

            assert.equal(__testing.getOpenClawPackageRootForTest(), envPackageRoot);
            assert.equal(__testing.getOpenClawBinForTest(), envBin);

            process.env.OPENCLAW_PACKAGE_ROOT = " ".repeat(3);
            process.env.OPENCLAW_BIN = " ".repeat(3);
            const defaultOpenClawPackageRoot = path.join(
                os.homedir(),
                ".npm-global/lib/node_modules/openclaw"
            );
            assert.equal(
                __testing.getOpenClawPackageRootForTest(),
                path.resolve(defaultOpenClawPackageRoot)
            );
            assert.equal(
                __testing.getOpenClawBinForTest(),
                path.join(os.homedir(), ".npm-global/bin/openclaw")
            );
        } finally {
            if (originalPackageRootEnv === undefined) {
                delete process.env.OPENCLAW_PACKAGE_ROOT;
            } else {
                process.env.OPENCLAW_PACKAGE_ROOT = originalPackageRootEnv;
            }
            if (originalBinEnv === undefined) {
                delete process.env.OPENCLAW_BIN;
            } else {
                process.env.OPENCLAW_BIN = originalBinEnv;
            }
            __testing.setOpenClawPackageRootForTest(undefined);
            __testing.setOpenClawBinForTest(undefined);
            await rm(tempDir, { recursive: true, force: true });
        }
    });
});
