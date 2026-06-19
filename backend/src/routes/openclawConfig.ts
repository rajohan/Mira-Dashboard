import { execFile } from "node:child_process";
import { promisify } from "node:util";

import express, { type RequestHandler } from "express";
import fs from "fs";
import os from "os";
import path from "path";

import gateway from "../gateway.ts";
import { errorMessage } from "../lib/errors.ts";
import { objectFallback, stringFallback } from "../lib/values.ts";

function dateToISOString(date: Date): string {
    return date.toISOString();
}

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

/** Applies a raw partial OpenClaw config update using the latest config hash. */
async function patchConfigRaw(raw: string): Promise<unknown> {
    const snapshot = await getConfigSnapshot();
    if (!snapshot.hash) {
        throw new Error("OpenClaw config hash unavailable");
    }

    return gateway.request("config.patch", {
        raw,
        baseHash: snapshot.hash,
        note: "Updated from Mira Dashboard settings",
    });
}

/** Applies a partial OpenClaw config update using the latest config hash. */
async function patchConfig(patch: Record<string, unknown>): Promise<unknown> {
    return patchConfigRaw(JSON.stringify(patch));
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

function getDefaultOpenClawPackageRoot(): string {
    const homeDirectory = process.env.HOME?.trim() || os.homedir();
    return path.resolve(
        process.env.OPENCLAW_PACKAGE_ROOT?.trim() ||
            path.join(homeDirectory, ".npm-global/lib/node_modules/openclaw")
    );
}

function getOpenClawPackageRoot(): string {
    return getDefaultOpenClawPackageRoot();
}

/** Resolves an absolute path without falling back to filesystem root. */
function resolveSafeAbsolutePath(candidate: string | undefined): string | null {
    const rawPath = candidate?.trim();
    if (!rawPath || !path.isAbsolute(rawPath)) {
        return null;
    }
    const resolvedPath = path.resolve(rawPath);
    if (resolvedPath === path.parse(resolvedPath).root) {
        return null;
    }
    try {
        return fs.realpathSync(resolvedPath);
    } catch {
        return resolvedPath;
    }
}

/** Resolves the configured OpenClaw root for workspace-backed settings. */
function resolveOpenClawHome(): string | null {
    const configuredRoot =
        process.env.OPENCLAW_HOME?.trim() ||
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME?.trim();
    if (configuredRoot) {
        return resolveSafeAbsolutePath(configuredRoot);
    }

    const homeDirectory =
        resolveSafeAbsolutePath(process.env.HOME) ?? os.homedir().trim();
    return resolveSafeAbsolutePath(path.join(homeDirectory, ".openclaw"));
}

function getOpenClawBin(): string {
    const homeDirectory = process.env.HOME?.trim() || os.homedir();
    return (
        process.env.OPENCLAW_BIN?.trim() ||
        path.join(homeDirectory, ".npm-global/bin/openclaw")
    );
}

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
function collectExtraSkillDirectories(openClawPackageRoot: string): string[] {
    const extensionsRoot = path.join(openClawPackageRoot, "dist/extensions");
    try {
        return fs
            .readdirSync(extensionsRoot, { withFileTypes: true })
            .flatMap((entry) =>
                entry.isDirectory()
                    ? collectSkillDirectories(
                          path.join(extensionsRoot, entry.name, "skills")
                      )
                    : []
            );
    } catch {
        return [];
    }
}

/** Returns configured skill entries. */
function getConfiguredSkillEntries(config?: Record<string, unknown>) {
    const skills = config?.skills;
    if (!skills || typeof skills !== "object" || Array.isArray(skills)) {
        return {};
    }

    const entries = (skills as { entries?: unknown }).entries;
    if (!entries || typeof entries !== "object" || Array.isArray(entries)) {
        return {};
    }

    return entries as Record<string, unknown>;
}

/** Merges configured, workspace, builtin, and extension skills for display. */
function getSkills(config: Record<string, unknown> | undefined): SkillInfo[] {
    const entries = getConfiguredSkillEntries(config);
    const skillsByName = new Map<string, SkillInfo>();
    const openClawHome = resolveOpenClawHome();
    const openClawPackageRoot = resolveSafeAbsolutePath(getOpenClawPackageRoot());

    /** Adds one discovered skill to the response map with configured state. */
    const addSkill = (skillPath: string, source: SkillSource) => {
        const name = path.basename(skillPath);
        const entry = objectFallback(entries[name] as object | null | undefined) as {
            enabled?: boolean;
            description?: string;
        };
        skillsByName.set(name, {
            name,
            path: `skills.entries.${name}`,
            enabled: entry.enabled !== false,
            description:
                typeof entry.description === "string"
                    ? entry.description
                    : readSkillDescription(skillPath),
            source,
        });
    };

    if (openClawHome) {
        const workspaceSkillDirectories = collectSkillDirectories(
            path.join(openClawHome, "workspace/skills")
        );
        for (const skillPath of workspaceSkillDirectories) {
            addSkill(skillPath, "workspace");
        }
    }

    if (openClawPackageRoot) {
        const builtinSkillDirectories = collectSkillDirectories(
            path.join(openClawPackageRoot, "skills")
        );
        for (const skillPath of builtinSkillDirectories) {
            addSkill(skillPath, "builtin");
        }
    }

    if (openClawPackageRoot) {
        for (const skillPath of collectExtraSkillDirectories(openClawPackageRoot)) {
            addSkill(skillPath, "extra");
        }
    }

    for (const [name, value] of Object.entries(entries)) {
        if (skillsByName.has(name)) {
            continue;
        }
        const entry = objectFallback(value as object | null | undefined) as {
            enabled?: boolean;
            description?: string;
        };
        skillsByName.set(name, {
            name,
            path: `skills.entries.${name}`,
            enabled: entry.enabled !== false,
            description: typeof entry.description === "string" ? entry.description : "",
            source: "extra",
        });
    }

    return skillsByName
        .values()
        .toArray()
        .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
}

/** Returns whether a discovered or configured skill key is safe to patch. */
function isValidSkillName(name: string): boolean {
    return (
        name.length > 0 &&
        name.length <= 128 &&
        !name.includes("\0") &&
        !name.includes("/") &&
        !name.includes("\\") &&
        name !== "__proto__" &&
        name !== "prototype" &&
        name !== "constructor"
    );
}

/** Registers OpenClaw config API routes. */
export default function openClawConfigRoutes(app: express.Application): void {
    app.get("/api/config", (async (_request, response) => {
        try {
            const snapshot = await getConfigSnapshot();
            response.json({ ...snapshot.parsed, __hash: snapshot.hash });
        } catch (error) {
            response
                .status(500)
                .json({ error: errorMessage(error, "Failed to load config") });
        }
    }) as RequestHandler);

    app.put("/api/config", express.json(), (async (request, response) => {
        if (
            !request.body ||
            typeof request.body !== "object" ||
            Array.isArray(request.body)
        ) {
            response.status(400).json({ error: "Invalid config: expected JSON object" });
            return;
        }

        try {
            const result = await patchConfig(request.body as Record<string, unknown>);
            response.json({ isOk: true, result });
        } catch (error) {
            response.status(500).json({
                error: errorMessage(error, "Failed to update config"),
            });
        }
    }) as RequestHandler);

    app.get("/api/skills", (async (_request, response) => {
        try {
            const snapshot = await getConfigSnapshot();
            response.json({ skills: getSkills(snapshot.parsed) });
        } catch (error) {
            response
                .status(500)
                .json({ error: errorMessage(error, "Failed to load skills") });
        }
    }) as RequestHandler);

    app.post("/api/backup", (async (_request, response) => {
        try {
            const snapshot = await getConfigSnapshot();
            response.json({
                createdAt: dateToISOString(new Date()),
                hash: snapshot.hash,
                config: snapshot.parsed || {},
            });
        } catch (error) {
            response.status(500).json({
                error: errorMessage(error, "Failed to create backup"),
            });
        }
    }) as RequestHandler);

    app.post("/api/restart", (async (_request, response) => {
        try {
            await execFileAsync(getOpenClawBin(), ["gateway", "restart"], {
                timeout: 30_000,
            });
            response.json({ isOk: true });
        } catch (error) {
            response.status(500).json({
                error: errorMessage(error, "Failed to restart gateway"),
            });
        }
    }) as RequestHandler);

    app.post("/api/skills/:name", express.json(), (async (request, response) => {
        try {
            const name = stringFallback(request.params.name).trim();
            if (!isValidSkillName(name)) {
                response.status(400).json({ error: "Invalid skill name" });
                return;
            }
            const body = request.body as null | { enabled?: unknown };
            const enabled = body && typeof body === "object" ? body.enabled : undefined;
            if (typeof enabled !== "boolean") {
                response.status(400).json({ error: "Invalid enabled value" });
                return;
            }

            await patchConfigRaw(
                `{"skills":{"entries":{${JSON.stringify(name)}:{"enabled":${JSON.stringify(enabled)}}}}}`
            );
            response.json({ isOk: true });
        } catch (error) {
            response.status(500).json({
                error: errorMessage(error, "Failed to update skill"),
            });
        }
    }) as RequestHandler);
}
