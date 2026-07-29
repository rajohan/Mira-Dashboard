import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
    type DashboardSettings,
    type DashboardSettingsPatch,
    type DashboardSettingsResponse,
    parseDashboardSettingsPatch,
} from "../../../contracts/settings.ts";
import gateway from "../gateway.ts";
import { json } from "../http.ts";
import {
    guardedPath,
    mkdirGuarded,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { readApiJsonOrError, routeFailureResponse } from "../routeSupport.ts";

const DEFAULT_SETTINGS: DashboardSettings = {
    defaultModel: "ollama/glm-5",
    refreshInterval: 5000,
    sidebarCollapsed: false,
    theme: "dark",
};
const settingsRouteState = {
    updateQueue: Promise.resolve(),
};
const logger = createStructuredLogger("settings");

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

async function loadSettings(): Promise<DashboardSettings> {
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
        return { ...DEFAULT_SETTINGS, ...parseDashboardSettingsPatch(persisted) };
    } catch {
        return DEFAULT_SETTINGS;
    }
}

async function saveSettings(settings: DashboardSettings): Promise<void> {
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
                return json({
                    ...settings,
                    gateway: gateway.getStatus(),
                } satisfies DashboardSettingsResponse);
            } catch (error) {
                logger.error("settings.load_failed", { error });
                return routeFailureResponse({
                    context: "settings",
                    message: "Failed to load settings",
                    status: 500,
                });
            }
        },
        PUT: async (request: Request) => {
            const patch: DashboardSettingsPatch | Response = await readApiJsonOrError(
                request,
                parseDashboardSettingsPatch,
                {
                    code: "invalid_settings",
                    context: "settings.update",
                    message: "Invalid settings payload",
                }
            );
            if (patch instanceof Response) return patch;

            try {
                return await withSettingsUpdateLock(async () => {
                    const current = await loadSettings();
                    const updated = { ...current, ...patch };
                    await saveSettings(updated);
                    return json(updated satisfies DashboardSettings);
                });
            } catch (error) {
                logger.error("settings.save_failed", { error });
                return routeFailureResponse({
                    context: "settings",
                    message: "Failed to save settings",
                    status: 500,
                });
            }
        },
    },
} as const;
