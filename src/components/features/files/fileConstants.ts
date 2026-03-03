// Config files to show in sidebar (matches backend whitelist)
export const CONFIG_TOP_FILES = [
    { path: "config:openclaw.json", label: "openclaw.json", relPath: "openclaw.json" },
];

export const CONFIG_DIR_FILES = [
    {
        path: "config:config/agents.json5",
        label: "agents.json5",
        relPath: "config/agents.json5",
    },
    {
        path: "config:config/channels.json5",
        label: "channels.json5",
        relPath: "config/channels.json5",
    },
    {
        path: "config:config/models.json5",
        label: "models.json5",
        relPath: "config/models.json5",
    },
];

export const CRON_DIR_FILES = [
    { path: "config:cron/jobs.json", label: "jobs.json", relPath: "cron/jobs.json" },
];

export const HOOKS_DIR_FILES = [
    {
        path: "config:hooks/transforms/agentmail.ts",
        label: "agentmail.ts",
        relPath: "hooks/transforms/agentmail.ts",
    },
];

export const MAX_PREVIEW_SIZE = 1024 * 1024;
