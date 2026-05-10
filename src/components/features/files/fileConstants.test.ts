import { describe, expect, it } from "vitest";

import {
    CONFIG_TOP_FILES,
    CRON_DIR_FILES,
    HOOKS_DIR_FILES,
    MAX_PREVIEW_SIZE,
} from "./fileConstants";

describe("file constants", () => {
    it("describes whitelisted config files shown in the sidebar", () => {
        expect(CONFIG_TOP_FILES).toEqual([
            {
                path: "config:openclaw.json",
                label: "openclaw.json",
                relPath: "openclaw.json",
            },
        ]);
        expect(CRON_DIR_FILES[0]).toMatchObject({
            path: "config:cron/jobs.json",
            label: "jobs.json",
            relPath: "cron/jobs.json",
        });
        expect(HOOKS_DIR_FILES[0]).toMatchObject({
            path: "config:hooks/transforms/agentmail.ts",
            label: "agentmail.ts",
            relPath: "hooks/transforms/agentmail.ts",
        });
        expect(MAX_PREVIEW_SIZE).toBe(1024 * 1024);
    });
});
