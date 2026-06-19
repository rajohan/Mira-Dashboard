import express, { type RequestHandler } from "express";
import fs from "fs";
import os from "os";
import path from "path";

import {
    guardedPath,
    mkdirGuarded,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.ts";

/** Represents settings. */
interface Settings {
    theme: "light" | "dark" | "system";
    sidebarCollapsed: boolean;
    defaultModel: string;
    refreshInterval: number;
}

/** Resolves dashboard settings directory from a home directory value. */
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

const DEFAULT_SETTINGS: Settings = {
    theme: "dark",
    sidebarCollapsed: false,
    defaultModel: "ollama/glm-5",
    refreshInterval: 5000,
};

/** Performs load settings. */
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

/** Returns a validated settings patch and rejects malformed input before persistence. */
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
            1_000,
            Math.min(60_000, Math.trunc(body.refreshInterval))
        );
    }

    return patch;
}

/** Performs save settings. */
async function saveSettings(settings: Settings): Promise<void> {
    const settingsDirectory = resolveSettingsDirectory();
    mkdirGuarded(guardedPath(settingsDirectory), { recursive: true });
    await withPinnedSettingsFile(settingsDirectory, (settingsFile) =>
        writeTextNoFollowGuarded(
            guardedPath(settingsFile),
            JSON.stringify(settings, null, 2)
        )
    );
}

/** Registers settings API routes. */
export default function settingsRoutes(
    app: express.Application,
    _express: typeof express,
    getGatewayStatus: () => { gateway: string; sessions: number }
): void {
    // Get settings
    app.get("/api/settings", (async (_request, response) => {
        try {
            const settings = await loadSettings();
            const gatewayStatus = getGatewayStatus();
            response.json({ ...settings, gateway: gatewayStatus });
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Update settings
    app.put("/api/settings", express.json(), (async (request, response) => {
        let current: Settings;
        let updated: Settings;

        try {
            current = await loadSettings();
        } catch (error) {
            response.status(500).json({ error: (error as Error).message });
            return;
        }

        try {
            updated = { ...current, ...parseSettingsPatch(request.body) };
        } catch (error) {
            response.status(400).json({ error: (error as Error).message });
            return;
        }

        try {
            await saveSettings(updated);
            response.json(updated);
        } catch (error) {
            console.error("[Settings] Save error:", (error as Error).message);
            response.status(500).json({ error: "Failed to save settings" });
        }
    }) as RequestHandler);
}
