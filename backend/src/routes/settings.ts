import express, { type RequestHandler } from "express";
import os from "os";
import path from "path";

import {
    guardedPath,
    mkdirGuarded,
    readTextNoFollowGuarded,
    writeTextNoFollowGuarded,
} from "../lib/guardedOps.js";

/** Represents settings. */
interface Settings {
    theme: "light" | "dark" | "system";
    sidebarCollapsed: boolean;
    defaultModel: string;
    refreshInterval: number;
}

/** Resolves dashboard settings directory from a home directory value. */
function resolveSettingsDir(home = process.env.HOME): string {
    const normalizedHome = home?.trim() || os.homedir().trim();
    if (
        !normalizedHome ||
        !path.isAbsolute(normalizedHome) ||
        path.resolve(normalizedHome) === path.parse(path.resolve(normalizedHome)).root
    ) {
        throw new Error("Invalid settings home directory");
    }
    return path.resolve(path.join(normalizedHome, ".openclaw"));
}

function resolveSettingsFile(): string {
    return path.join(resolveSettingsDir(), "dashboard-settings.json");
}

const DEFAULT_SETTINGS: Settings = {
    theme: "dark",
    sidebarCollapsed: false,
    defaultModel: "ollama/glm-5",
    refreshInterval: 5000,
};

/** Performs load settings. */
async function loadSettings(): Promise<Settings> {
    try {
        const content = await readTextNoFollowGuarded(guardedPath(resolveSettingsFile()));
        const persisted = JSON.parse(content) as unknown;
        return { ...DEFAULT_SETTINGS, ...parseSettingsPatch(persisted) };
    } catch {
        // File doesn't exist or is unreadable; return defaults
    }
    return DEFAULT_SETTINGS;
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
    const settingsDir = resolveSettingsDir();
    mkdirGuarded(guardedPath(settingsDir), { recursive: true });
    await writeTextNoFollowGuarded(
        guardedPath(path.join(settingsDir, "dashboard-settings.json")),
        JSON.stringify(settings, null, 2)
    );
}

/** Registers settings API routes. */
export default function settingsRoutes(
    app: express.Application,
    _express: typeof express,
    getGatewayStatus: () => { gateway: string; sessions: number }
): void {
    // Get settings
    app.get("/api/settings", (async (_req, res) => {
        try {
            const settings = await loadSettings();
            const gatewayStatus = getGatewayStatus();
            res.json({ ...settings, gateway: gatewayStatus });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Update settings
    app.put("/api/settings", express.json(), (async (req, res) => {
        let updated: Settings;
        try {
            const current = await loadSettings();
            updated = { ...current, ...parseSettingsPatch(req.body) };
        } catch (error) {
            res.status(400).json({ error: (error as Error).message });
            return;
        }

        try {
            await saveSettings(updated);
            res.json(updated);
        } catch (error) {
            console.error("[Settings] Save error:", (error as Error).message);
            res.status(500).json({ error: "Failed to save settings" });
        }
    }) as RequestHandler);
}

export const __testing = {
    resolveSettingsDir,
    resolveSettingsFile,
};
