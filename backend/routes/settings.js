// Settings API routes
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const CONFIG_PATH = path.join(process.env.HOME, ".openclaw", "openclaw.json");
const SKILLS_DIR = path.join(process.env.HOME, ".openclaw", "workspace", "skills");
const ALLOWED_CONFIG_FIELDS = [
    "session.reset.idleMinutes",
    "heartbeat.every",
    "heartbeat.target",
];

function sanitizeConfig(config) {
    const sanitized = JSON.parse(JSON.stringify(config));
    if (sanitized.discord?.token) sanitized.discord.token = "***";
    if (sanitized.openai?.apiKey) sanitized.openai.apiKey = "***";
    if (sanitized.anthropic?.apiKey) sanitized.anthropic.apiKey = "***";
    if (sanitized.channels?.discord?.token) sanitized.channels.discord.token = "***";
    delete sanitized.webhooks;
    delete sanitized.secrets;
    return sanitized;
}

module.exports = function (app, express, getGatewayStatus) {
    // Get config
    app.get("/api/config", async (req, res) => {
        try {
            if (!fs.existsSync(CONFIG_PATH)) {
                return res.status(404).json({ error: "Config not found" });
            }
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
            res.json(sanitizeConfig(config));
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Update config
    app.patch("/api/config", express.json(), async (req, res) => {
        try {
            const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));

            for (const [key, value] of Object.entries(req.body)) {
                if (!ALLOWED_CONFIG_FIELDS.includes(key)) {
                    return res.status(400).json({ error: "Field not allowed: " + key });
                }
                const parts = key.split(".");
                let obj = config;
                for (let i = 0; i < parts.length - 1; i++) {
                    if (!obj[parts[i]]) obj[parts[i]] = {};
                    obj = obj[parts[i]];
                }
                obj[parts[parts.length - 1]] = value;
            }

            fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
            res.json({ success: true });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // List skills
    app.get("/api/skills", async (req, res) => {
        try {
            if (!fs.existsSync(SKILLS_DIR)) {
                return res.json({ skills: [] });
            }

            const skills = fs
                .readdirSync(SKILLS_DIR)
                .filter((name) => fs.statSync(path.join(SKILLS_DIR, name)).isDirectory())
                .map((name) => ({
                    name: name,
                    enabled: true,
                    path: path.join(SKILLS_DIR, name),
                }));

            res.json({ skills });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Enable skill
    app.post("/api/skills/:name/enable", async (req, res) => {
        res.json({ success: true, name: req.params.name, enabled: true });
    });

    // Disable skill
    app.post("/api/skills/:name/disable", async (req, res) => {
        res.json({ success: true, name: req.params.name, enabled: false });
    });

    // Restart gateway
    app.post("/api/operations/restart", async (req, res) => {
        try {
            spawn("sudo", ["systemctl", "restart", "openclaw"], { detached: true });
            res.json({ success: true, message: "Gateway restart initiated" });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Backup workspace
    app.post("/api/operations/backup", async (req, res) => {
        try {
            const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
            const backupFile = "/tmp/openclaw-backup-" + timestamp + ".tar.gz";
            const workspacePath = path.join(process.env.HOME, ".openclaw");

            spawn("tar", [
                "-czf",
                backupFile,
                "-C",
                path.dirname(workspacePath),
                path.basename(workspacePath),
            ]);

            res.json({ success: true, file: backupFile });
        } catch (e) {
            res.status(500).json({ error: e.message });
        }
    });

    // Operations status
    app.get("/api/operations/status", async (req, res) => {
        const status = getGatewayStatus
            ? getGatewayStatus()
            : { gateway: "unknown", sessions: 0 };
        res.json(status);
    });
};
