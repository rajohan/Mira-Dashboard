import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import gateway from "../gateway.ts";
import { json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import {
    guardedPath,
    mkdirGuarded,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.ts";

interface Settings {
    defaultModel: string;
    refreshInterval: number;
    sidebarCollapsed: boolean;
    theme: "light" | "dark" | "system";
}

const DEFAULT_SETTINGS: Settings = {
    defaultModel: "ollama/glm-5",
    refreshInterval: 5000,
    sidebarCollapsed: false,
    theme: "dark",
};
const settingsRouteState = {
    updateQueue: Promise.resolve(),
};

async function withSettingsUpdateLock<T>(callback: () => Promise<T>): Promise<T> {
    const previous = settingsRouteState.updateQueue;
    const current = Promise.withResolvers<void>();
    settingsRouteState.updateQueue = current.promise;
    await previous;
    try {
        return await callback();
    } finally {
        current.resolve();
    }
}

function resolveSettingsDirectory(home = process.env.HOME): string {
    const normalizedHome = home?.trim() || os.homedir().trim();
    if (
        !normalizedHome ||
        !path.isAbsolute(normalizedHome) ||
        path.resolve(normalizedHome) === path.parse(path.resolve(normalizedHome)).root
    ) {
        throw new Error("Invalid settings home directory");
    }
    const settingsDirectory = path.resolve(path.join(normalizedHome, ".openclaw"));
    try {
        if (fs.lstatSync(settingsDirectory).isSymbolicLink()) {
            throw new Error("Invalid settings directory");
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
        }
    }
    return settingsDirectory;
}

async function withPinnedSettingsFile<T>(
    settingsDirectory: string,
    callback: (settingsFile: string) => Promise<T> | T
): Promise<T> {
    if (process.platform !== "linux") {
        return callback(path.join(settingsDirectory, "dashboard-settings.json"));
    }

    const parentFd = fs.openSync(
        settingsDirectory,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
    );
    try {
        const realSettingsDirectory = fs.realpathSync(settingsDirectory);
        const realPinnedDirectory = fs.realpathSync(`/proc/self/fd/${parentFd}`);
        if (realPinnedDirectory !== realSettingsDirectory) {
            throw new Error("Invalid settings directory");
        }

        return await callback(`/proc/self/fd/${parentFd}/dashboard-settings.json`);
    } finally {
        fs.closeSync(parentFd);
    }
}

function parseSettingsPatch(input: unknown): Partial<Settings> {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("Settings payload must be an object");
    }

    const body = input as Record<string, unknown>;
    const patch: Partial<Settings> = {};

    if ("theme" in body) {
        if (body.theme !== "light" && body.theme !== "dark" && body.theme !== "system") {
            throw new Error("Invalid theme");
        }
        patch.theme = body.theme;
    }

    if ("sidebarCollapsed" in body) {
        if (typeof body.sidebarCollapsed !== "boolean") {
            throw new TypeError("Invalid sidebarCollapsed setting");
        }
        patch.sidebarCollapsed = body.sidebarCollapsed;
    }

    if ("defaultModel" in body) {
        if (
            typeof body.defaultModel !== "string" ||
            body.defaultModel.trim().length === 0 ||
            body.defaultModel.length > 200 ||
            body.defaultModel.includes("\0")
        ) {
            throw new Error("Invalid defaultModel setting");
        }
        patch.defaultModel = body.defaultModel.trim();
    }

    if ("refreshInterval" in body) {
        if (
            typeof body.refreshInterval !== "number" ||
            !Number.isFinite(body.refreshInterval)
        ) {
            throw new TypeError("Invalid refreshInterval setting");
        }
        patch.refreshInterval = Math.max(
            // eslint-disable-next-line unicorn/numeric-separators-style
            1_000,
            Math.min(60_000, Math.trunc(body.refreshInterval))
        );
    }

    return patch;
}

async function loadSettings(): Promise<Settings> {
    const settingsDirectory = resolveSettingsDirectory();
    let content: string;

    try {
        content = await withPinnedSettingsFile(settingsDirectory, (settingsFile) =>
            readTextNoFollowGuarded(guardedPath(settingsFile))
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return DEFAULT_SETTINGS;
        }
        throw error;
    }

    try {
        const persisted = JSON.parse(content) as unknown;
        return { ...DEFAULT_SETTINGS, ...parseSettingsPatch(persisted) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

async function saveSettings(settings: Settings): Promise<void> {
    const settingsDirectory = resolveSettingsDirectory();
    mkdirGuarded(guardedPath(settingsDirectory), { recursive: true });
    await withPinnedSettingsFile(settingsDirectory, (settingsFile) =>
        writeTextNoFollowGuarded(
            guardedPath(settingsFile),
            JSON.stringify(settings, undefined, 2)
        )
    );
}

export const settingsRoutes = {
    "/api/settings": {
        GET: async () => {
            try {
                const settings = await loadSettings();
                return json({ ...settings, gateway: gateway.getStatus() });
            } catch (error) {
                console.error("[Settings] Failed to load settings:", error);
                return json({ error: "Failed to load settings" }, { status: 500 });
            }
        },
        PUT: async (request: Request) => {
            let patch: Partial<Settings>;
            try {
                const body = await readJson(request);
                patch = parseSettingsPatch(body);
            } catch (error) {
                const mappedStatus = httpStatusCode(error);
                const status = mappedStatus === 500 ? 400 : mappedStatus;
                return json(
                    {
                        error:
                            status >= 500
                                ? "Internal server error"
                                : errorMessage(error, "Invalid settings payload"),
                    },
                    { status }
                );
            }

            try {
                return await withSettingsUpdateLock(async () => {
                    const current = await loadSettings();
                    const updated = { ...current, ...patch };
                    await saveSettings(updated);
                    return json(updated);
                });
            } catch (error) {
                console.error(
                    "[Settings] Save error:",
                    errorMessage(error, "Unknown error")
                );
                return json({ error: "Failed to save settings" }, { status: 500 });
            }
        },
    },
} as const;
