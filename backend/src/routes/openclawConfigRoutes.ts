import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import gateway from "../gateway.ts";
import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { runProcess } from "../lib/processes.ts";
import { objectFallback, stringFallback } from "../lib/values.ts";

type ParametersRequest<T extends string> = Request & { params: Record<T, string> };

interface ConfigGetResponse {
    hash?: string;
    parsed?: Record<string, unknown>;
}

type SkillSource = "workspace" | "builtin" | "extra";

interface SkillInfo {
    description?: string;
    enabled: boolean;
    name: string;
    path: string;
    source: SkillSource;
}

function dateToISOString(date: Date): string {
    return date.toISOString();
}

async function getConfigSnapshot(): Promise<ConfigGetResponse> {
    return (await gateway.request("config.get", {})) as ConfigGetResponse;
}

async function patchConfigRaw(raw: string, baseHash: string): Promise<unknown> {
    return gateway.request("config.patch", {
        baseHash,
        note: "Updated from Mira Dashboard settings",
        raw,
    });
}

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

function resolveSafeAbsolutePath(candidate: string | undefined): string | undefined {
    const rawPath = candidate?.trim();
    if (!rawPath || !path.isAbsolute(rawPath)) {
        return undefined;
    }
    const resolvedPath = path.resolve(rawPath);
    if (resolvedPath === path.parse(resolvedPath).root) {
        return undefined;
    }
    try {
        return fs.realpathSync(resolvedPath);
    } catch {
        return resolvedPath;
    }
}

function resolveOpenClawHome(): string | undefined {
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

function getSkills(config: Record<string, unknown> | undefined): SkillInfo[] {
    const entries = getConfiguredSkillEntries(config);
    const skillsByName = new Map<string, SkillInfo>();
    const openClawHome = resolveOpenClawHome();
    const openClawPackageRoot = resolveSafeAbsolutePath(getOpenClawPackageRoot());

    const addSkill = (skillPath: string, source: SkillSource) => {
        const name = path.basename(skillPath);
        const entry = objectFallback(entries[name] as object | undefined) as {
            description?: string;
            enabled?: boolean;
        };
        skillsByName.set(name, {
            description:
                typeof entry.description === "string"
                    ? entry.description
                    : readSkillDescription(skillPath),
            enabled: entry.enabled !== false,
            name,
            path: `skills.entries.${name}`,
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
        for (const skillPath of collectExtraSkillDirectories(openClawPackageRoot)) {
            addSkill(skillPath, "extra");
        }
    }

    for (const [name, value] of Object.entries(entries)) {
        if (skillsByName.has(name)) continue;
        const entry = objectFallback(value as object | undefined) as {
            description?: string;
            enabled?: boolean;
        };
        skillsByName.set(name, {
            description: typeof entry.description === "string" ? entry.description : "",
            enabled: entry.enabled !== false,
            name,
            path: `skills.entries.${name}`,
            source: "extra",
        });
    }

    return skillsByName
        .values()
        .toArray()
        .toSorted(
            (a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name)
        );
}

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

export const openclawConfigRoutes = {
    "/api/config": {
        GET: async () => {
            try {
                const snapshot = await getConfigSnapshot();
                return json({ ...snapshot.parsed, __hash: snapshot.hash });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to load config") },
                    { status: 500 }
                );
            }
        },
        PUT: async (request: Request) => {
            try {
                const body = await readJson<unknown>(request);
                if (!body || typeof body !== "object" || Array.isArray(body)) {
                    return json(
                        { error: "Invalid config: expected JSON object" },
                        { status: 400 }
                    );
                }
                const baseHash = (body as Record<string, unknown>).__hash;
                if (typeof baseHash !== "string" || !baseHash.trim()) {
                    return json({ error: "Config hash is required" }, { status: 400 });
                }
                const configBody = { ...(body as Record<string, unknown>) };
                delete configBody.__hash;
                const result = await patchConfigRaw(
                    JSON.stringify(configBody),
                    baseHash.trim()
                );
                return json({ isOk: true, result });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to update config") },
                    { status: httpStatusCode(error) }
                );
            }
        },
    },

    "/api/skills": {
        GET: async () => {
            try {
                const snapshot = await getConfigSnapshot();
                return json({ skills: getSkills(snapshot.parsed) });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to load skills") },
                    { status: 500 }
                );
            }
        },
    },

    "/api/backup": {
        POST: async () => {
            try {
                const snapshot = await getConfigSnapshot();
                return json({
                    config: snapshot.parsed || {},
                    createdAt: dateToISOString(new Date()),
                    hash: snapshot.hash,
                });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to create backup") },
                    { status: 500 }
                );
            }
        },
    },

    "/api/restart": {
        POST: async () => {
            try {
                const { code, stderr, stdout } = await runProcess(
                    getOpenClawBin(),
                    ["gateway", "restart"],
                    {
                        timeoutMs: 30_000,
                    }
                );
                if (code !== 0) {
                    throw new Error(
                        stderr.trim() || stdout.trim() || `openclaw exited ${code}`
                    );
                }
                return json({ isOk: true });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to restart gateway") },
                    { status: 500 }
                );
            }
        },
    },

    "/api/skills/:name": {
        POST: async (request: ParametersRequest<"name">) => {
            try {
                const name = stringFallback(request.params.name).trim();
                if (!isValidSkillName(name)) {
                    return json({ error: "Invalid skill name" }, { status: 400 });
                }
                const body = await readJson<
                    | {
                          __hash?: unknown;
                          enabled?: unknown;
                      }
                    | undefined
                >(request);
                const enabled =
                    body && typeof body === "object" ? body.enabled : undefined;
                if (typeof enabled !== "boolean") {
                    return json({ error: "Invalid enabled value" }, { status: 400 });
                }
                const baseHash =
                    body && typeof body === "object" ? body.__hash : undefined;
                if (typeof baseHash !== "string" || !baseHash.trim()) {
                    return json({ error: "Config hash is required" }, { status: 400 });
                }

                await patchConfigRaw(
                    JSON.stringify({
                        skills: { entries: { [name]: { enabled } } },
                    }),
                    baseHash.trim()
                );
                return json({ isOk: true });
            } catch (error) {
                return json(
                    { error: errorMessage(error, "Failed to update skill") },
                    { status: httpStatusCode(error) }
                );
            }
        },
    },
} as const;
