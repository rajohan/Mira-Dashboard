import express, { type RequestHandler } from "express";
import fs from "fs";
import path from "path";

/** Represents settings. */
interface Settings {
    theme: "light" | "dark" | "system";
    sidebarCollapsed: boolean;
    defaultModel: string;
    refreshInterval: number;
}

const SETTINGS_FILE = path.join(
    process.env.HOME || "",
    ".openclaw",
    "dashboard-settings.json"
);

const DEFAULT_SETTINGS: Settings = {
    theme: "dark",
    sidebarCollapsed: false,
    defaultModel: "ollama/glm-5",
    refreshInterval: 5000,
};

/** Performs load settings. */
function loadSettings(): Settings {
    try {
        if (fs.existsSync(SETTINGS_FILE)) {
            const content = fs.readFileSync(SETTINGS_FILE, "utf8");
            return { ...DEFAULT_SETTINGS, ...JSON.parse(content) };
        }
    } catch (error) {
        console.error("[Settings] Load error:", (error as Error).message);
    }
    return DEFAULT_SETTINGS;
}

/** Performs save settings. */
function saveSettings(settings: Settings): void {
    try {
        const dir = path.dirname(SETTINGS_FILE);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), "utf8");
    } catch (error) {
        console.error("[Settings] Save error:", (error as Error).message);
    }
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
            const settings = loadSettings();
            const gatewayStatus = getGatewayStatus();
            res.json({ ...settings, gateway: gatewayStatus });
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);

    // Update settings
    app.put("/api/settings", express.json(), (async (req, res) => {
        try {
            const current = loadSettings();
            const updated = { ...current, ...(req.body as Partial<Settings>) };
            saveSettings(updated);
            res.json(updated);
        } catch (error) {
            res.status(500).json({ error: (error as Error).message });
        }
    }) as RequestHandler);
}
