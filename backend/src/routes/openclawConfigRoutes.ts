import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    parseOpenClawConfigUpdateRequest,
    parseOpenClawSkillUpdateRequest,
    type OpenClawMutationResponse,
    type OpenClawSkill,
    type OpenClawSkillSource,
} from "../../../contracts/openClawConfig.ts";
import gateway from "../gateway.ts";
import { json } from "../http.ts";
import { guardedPath, openReadNoFollowNonblockingGuarded } from "../lib/guardedOps.ts";
import { objectFallback, stringFallback } from "../lib/values.ts";
import {
    type ParametersRequest,
    readApiJsonOrError,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    hasConfigRedactionSentinel,
    redactConfigSecrets,
    restoreConfigRedactionSentinels,
} from "../services/configRedaction.ts";
import { OPENCLAW_GATEWAY_RESTART_ACTION } from "../services/openclawActions.ts";
import {
    enqueueAndWaitForJobExecution,
    successfulJobExecutionOutput,
} from "../services/queuedJobExecution.ts";

interface ConfigGetResponse {
    hash?: string;
    parsed?: Record<string, unknown>;
}

const MAX_SKILL_MANIFEST_BYTES = 256 * 1024;

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
        const realPath = fs.realpathSync(resolvedPath);
        return realPath === path.parse(realPath).root ? undefined : realPath;
    } catch {
        return resolvedPath;
    }
}

function resolveOpenClawHome(): string | undefined {
    const configuredRoot = process.env.OPENCLAW_HOME?.trim();
    if (configuredRoot) {
        return resolveSafeAbsolutePath(configuredRoot);
    }

    const homeDirectory =
        resolveSafeAbsolutePath(process.env.HOME) ?? os.homedir().trim();
    return resolveSafeAbsolutePath(path.join(homeDirectory, ".openclaw"));
}

async function readSkillDescription(skillPath: string): Promise<string | undefined> {
    let file: Awaited<ReturnType<typeof openReadNoFollowNonblockingGuarded>> | undefined;
    try {
        file = await openReadNoFollowNonblockingGuarded(
            guardedPath(path.join(skillPath, "SKILL.md"))
        );
        const stat = await file.stat();
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size <= 0 ||
            stat.size > MAX_SKILL_MANIFEST_BYTES
        ) {
            return undefined;
        }
        const buffer = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(buffer, 0, stat.size, 0);
        const content = buffer.subarray(0, bytesRead).toString("utf8");
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
    } finally {
        await file?.close();
    }
}

function isBoundedSkillManifest(skillPath: string): boolean {
    try {
        const stat = fs.lstatSync(path.join(skillPath, "SKILL.md"));
        return (
            stat.isFile() &&
            !stat.isSymbolicLink() &&
            stat.nlink === 1 &&
            stat.size > 0 &&
            stat.size <= MAX_SKILL_MANIFEST_BYTES
        );
    } catch {
        return false;
    }
}

function collectSkillDirectories(root: string): string[] {
    try {
        return fs
            .readdirSync(root, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => path.join(root, entry.name))
            .filter((directory) => isBoundedSkillManifest(directory));
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

async function getSkills(
    config: Record<string, unknown> | undefined
): Promise<OpenClawSkill[]> {
    const entries = getConfiguredSkillEntries(config);
    const skillsByName = new Map<string, OpenClawSkill>();
    const openClawHome = resolveOpenClawHome();
    const openClawPackageRoot = resolveSafeAbsolutePath(getOpenClawPackageRoot());

    const addSkill = async (skillPath: string, source: OpenClawSkillSource) => {
        const name = path.basename(skillPath);
        const entry = objectFallback(entries[name] as object | undefined) as {
            description?: string;
            enabled?: boolean;
        };
        skillsByName.set(name, {
            description:
                typeof entry.description === "string"
                    ? entry.description
                    : await readSkillDescription(skillPath),
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
            await addSkill(skillPath, "workspace");
        }
    }

    if (openClawPackageRoot) {
        const builtinSkillDirectories = collectSkillDirectories(
            path.join(openClawPackageRoot, "skills")
        );
        for (const skillPath of builtinSkillDirectories) {
            await addSkill(skillPath, "builtin");
        }
        for (const skillPath of collectExtraSkillDirectories(openClawPackageRoot)) {
            await addSkill(skillPath, "extra");
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
                const parsed = redactConfigSecrets(snapshot.parsed ?? {}) as Record<
                    string,
                    unknown
                >;
                return json({
                    ...parsed,
                    __hash: snapshot.hash,
                    __masked: true,
                });
            } catch (error) {
                return routeErrorResponse(undefined, error, {
                    code: "openclaw_config_load_failed",
                    context: "openclaw-config.load",
                    message: "Failed to load config",
                });
            }
        },
        PUT: async (request: Request) => {
            try {
                const body = await readApiJsonOrError(
                    request,
                    parseOpenClawConfigUpdateRequest,
                    {
                        code: "invalid_openclaw_config",
                        context: "openclaw-config.update",
                        message: "Invalid OpenClaw config",
                    }
                );
                if (body instanceof Response) return body;
                const baseHash = body.__hash;
                const configBody: Record<string, unknown> = { ...body };
                delete configBody.__hash;
                delete configBody.__masked;
                const snapshot = await getConfigSnapshot();
                const restoredConfigBody = restoreConfigRedactionSentinels(
                    configBody,
                    snapshot.parsed ?? {}
                );
                if (hasConfigRedactionSentinel(restoredConfigBody)) {
                    return routeFailureResponse({
                        context: "openclaw-config",
                        message:
                            "Masked secret placeholder has no corresponding stored value",
                        status: 400,
                    });
                }
                const result = await patchConfigRaw(
                    JSON.stringify(restoredConfigBody),
                    baseHash
                );
                return json({
                    isOk: true,
                    result: redactConfigSecrets(result),
                });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "openclaw_config_update_failed",
                    context: "openclaw-config.update",
                    message: "Failed to update config",
                });
            }
        },
    },

    "/api/skills": {
        GET: async () => {
            try {
                const snapshot = await getConfigSnapshot();
                return json({ skills: await getSkills(snapshot.parsed) });
            } catch (error) {
                return routeErrorResponse(undefined, error, {
                    code: "openclaw_skills_load_failed",
                    context: "openclaw-config.skills",
                    message: "Failed to load skills",
                });
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
                return routeErrorResponse(undefined, error, {
                    code: "openclaw_backup_failed",
                    context: "openclaw-config.backup",
                    message: "Failed to create backup",
                });
            }
        },
    },

    "/api/restart": {
        POST: async (request: Request) => {
            try {
                const execution = await enqueueAndWaitForJobExecution({
                    actionKey: OPENCLAW_GATEWAY_RESTART_ACTION,
                    displayName: "Restart OpenClaw Gateway",
                    resourceClass: "exclusive",
                    timeoutMs: 60_000,
                });
                successfulJobExecutionOutput(execution);
                return json({ isOk: true } satisfies OpenClawMutationResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "openclaw_restart_failed",
                    context: "openclaw-config.restart",
                    message: "Failed to restart gateway",
                });
            }
        },
    },

    "/api/skills/:name": {
        POST: async (request: ParametersRequest<"name">) => {
            try {
                const name = stringFallback(request.params.name).trim();
                if (!isValidSkillName(name)) {
                    return routeFailureResponse({
                        context: "openclaw-config",
                        message: "Invalid skill name",
                        status: 400,
                    });
                }
                const body = await readApiJsonOrError(
                    request,
                    parseOpenClawSkillUpdateRequest,
                    {
                        code: "invalid_openclaw_skill_update",
                        context: "openclaw-config.skill",
                        message: "Invalid OpenClaw skill update",
                    }
                );
                if (body instanceof Response) return body;

                await patchConfigRaw(
                    JSON.stringify({
                        skills: { entries: { [name]: { enabled: body.enabled } } },
                    }),
                    body.__hash
                );
                return json({ isOk: true } satisfies OpenClawMutationResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "openclaw_skill_update_failed",
                    context: "openclaw-config.skill",
                    message: "Failed to update skill",
                });
            }
        },
    },
} as const;
