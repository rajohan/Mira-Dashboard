import { execFile } from "node:child_process";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";
import fs from "fs";
import os from "os";
import path from "path";

import gateway from "../gateway.js";

/** Represents the config get API response. */
interface ConfigGetResponse {
    parsed?: Record<string, unknown>;
    hash?: string;
}

/** Fetches the current OpenClaw config snapshot and hash. */
async function getConfigSnapshot(): Promise<ConfigGetResponse> {
    const response = (await gateway.request("config.get", {})) as ConfigGetResponse;
    return response;
}

/** Applies a partial OpenClaw config update using the latest config hash. */
async function patchConfig(patch: Record<string, unknown>): Promise<unknown> {
    const snapshot = await getConfigSnapshot();
    if (!snapshot.hash) {
        throw new Error("OpenClaw config hash unavailable");
    }

    return gateway.request("config.patch", {
        raw: JSON.stringify(patch),
        baseHash: snapshot.hash,
        note: "Updated from Mira Dashboard settings",
    });
}

/** Defines skill source. */
type SkillSource = "workspace" | "builtin" | "extra";

/** Represents skill info. */
interface SkillInfo {
    name: string;
    path: string;
    enabled: boolean;
    description?: string;
    source: SkillSource;
}

const execFileAsync = promisify(execFile);

const OPENCLAW_PACKAGE_ROOT = path.resolve(
    process.env.OPENCLAW_PACKAGE_ROOT ||
        path.join(os.homedir(), ".npm-global/lib/node_modules/openclaw")
);

const OPENCLAW_BIN =
    process.env.OPENCLAW_BIN || path.join(os.homedir(), ".npm-global/bin/openclaw");

/** Reads the first available skill description from SKILL.md. */
function readSkillDescription(skillPath: string): string | undefined {
    try {
        const content = fs.readFileSync(path.join(skillPath, "SKILL.md"), "utf8");
        const description = content.match(/^description:\s*(.+)$/m)?.[1];
        if (description) {
            return description.replaceAll(/^['"]|['"]$/g, "");
        }

        return content
            .split("\n")
            .find(
                (line) => line.trim() && !line.startsWith("---") && !line.startsWith("#")
            )
            ?.trim();
    } catch {
        return undefined;
    }
}

/** Finds child directories that contain a SKILL.md file. */
function collectSkillDirectories(root: string): string[] {
    try {
        return fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(root, entry.name))
            .filter((skillPath) => fs.existsSync(path.join(skillPath, "SKILL.md")));
    } catch {
        return [];
    }
}

/** Finds bundled extension skill directories under the OpenClaw package root. */
function collectExtraSkillDirectories(): string[] {
    const extensionsRoot = path.join(OPENCLAW_PACKAGE_ROOT, "dist/extensions");
    try {
        return fs
            .readdirSync(extensionsRoot, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .flatMap((entry) =>
                collectSkillDirectories(path.join(extensionsRoot, entry.name, "skills"))
            );
    } catch {
        return [];
    }
}

/** Returns configured skill entries. */
function getConfiguredSkillEntries(config: Record<string, unknown> | undefined) {
    const skills = config?.skills as { entries?: Record<string, unknown> } | undefined;
    return skills?.entries || {};
}

/** Merges configured, workspace, builtin, and extension skills for display. */
function getSkills(config: Record<string, unknown> | undefined): SkillInfo[] {
    const entries = getConfiguredSkillEntries(config);
    const skillsByName = new Map<string, SkillInfo>();

    /** Adds one discovered skill to the response map with configured state. */
    const addSkill = (skillPath: string, source: SkillSource) => {
        const name = path.basename(skillPath);
        const entry = (entries[name] || {}) as {
            enabled?: boolean;
            description?: string;
        };
        skillsByName.set(name, {
            name,
            path: `skills.entries.${name}`,
            enabled: entry.enabled !== false,
            description: entry.description || readSkillDescription(skillPath),
            source,
        });
    };

    for (const skillPath of collectSkillDirectories(
        path.join(os.homedir(), ".openclaw/workspace/skills")
    )) {
        addSkill(skillPath, "workspace");
    }

    for (const skillPath of collectSkillDirectories(
        path.join(OPENCLAW_PACKAGE_ROOT, "skills")
    )) {
        addSkill(skillPath, "builtin");
    }

    for (const skillPath of collectExtraSkillDirectories()) {
        addSkill(skillPath, "extra");
    }

    for (const [name, value] of Object.entries(entries)) {
        if (skillsByName.has(name)) {
            continue;
        }

        const entry = (value || {}) as { enabled?: boolean; description?: string };
        skillsByName.set(name, {
            name,
            path: `skills.entries.${name}`,
            enabled: entry.enabled !== false,
            description: entry.description,
            source: "extra",
        });
    }

    return [...skillsByName.values()].sort(
        (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
    );
}

/** Registers OpenClaw config API routes. */
export default function openClawConfigRoutes(app: express.Application): void {
    app.get("/api/config", (async (_req, res) => {
        try {
            const snapshot = await getConfigSnapshot();
            res.json({ ...snapshot.parsed, __hash: snapshot.hash });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.put("/api/config", express.json(), (async (req, res) => {
        try {
            const result = await patchConfig(req.body as Record<string, unknown>);
            res.json({ ok: true, result });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.get("/api/skills", (async (_req, res) => {
        try {
            const snapshot = await getConfigSnapshot();
            res.json({ skills: getSkills(snapshot.parsed) });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/backup", (async (_req, res) => {
        try {
            const snapshot = await getConfigSnapshot();
            res.json({
                createdAt: new Date().toISOString(),
                hash: snapshot.hash,
                config: snapshot.parsed || {},
            });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    app.post("/api/restart", (async (_req, res) => {
        try {
            await execFileAsync(OPENCLAW_BIN, ["gateway", "restart"], {
                timeout: 30_000,
            });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({
                error:
                    error instanceof Error ? error.message : "Failed to restart gateway",
            });
        }
    }) as RequestHandler);

    app.post("/api/skills/:name", express.json(), (async (req, res) => {
        try {
            const name = String(req.params.name || "");
            const enabled = Boolean((req.body as { enabled?: boolean }).enabled);

            if (!name || !/^[a-zA-Z0-9_-]+$/u.test(name)) {
                res.status(400).json({ error: "Invalid skill name" });
                return;
            }

            await patchConfig({
                skills: {
                    entries: {
                        [name]: { enabled },
                    },
                },
            });
            res.json({ ok: true });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
