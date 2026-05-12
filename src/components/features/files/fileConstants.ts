// Config files to show in sidebar (matches backend whitelist)
/** Stores config top files. */
export const CONFIG_TOP_FILES = [
    { path: "config:openclaw.json", label: "openclaw.json", relPath: "openclaw.json" },
];

/** Stores cron dir files. */
export const CRON_DIR_FILES = [
    { path: "config:cron/jobs.json", label: "jobs.json", relPath: "cron/jobs.json" },
];

/** Stores hooks dir files. */
export const HOOKS_DIR_FILES = [
    {
        path: "config:hooks/transforms/agentmail.ts",
        label: "agentmail.ts",
        relPath: "hooks/transforms/agentmail.ts",
    },
];

/** Stores max preview size. */
export const MAX_PREVIEW_SIZE = 1024 * 1024;
