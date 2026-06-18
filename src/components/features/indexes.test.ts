import { describe, expect, it } from "bun:test";

import * as cron from "./cron";
import * as dashboard from "./dashboard";
import * as files from "./files";
import * as logs from "./logs";
import * as moltbook from "./moltbook";
import * as sessions from "./sessions";
import * as settings from "./settings";
import * as tasks from "./tasks";

describe("feature barrels", () => {
    it("re-exports cron components", () => {
        expect(cron.CronJobDetails).toBeDefined();
        expect(cron.CronJobList).toBeDefined();
    });

    it("re-exports dashboard cards", () => {
        expect(dashboard.BackupOverviewCard).toBeDefined();
        expect(dashboard.CacheStatusCard).toBeDefined();
        expect(dashboard.CronOverviewCard).toBeDefined();
        expect(dashboard.GitOverviewCard).toBeDefined();
        expect(dashboard.LogRotationCard).toBeDefined();
        expect(dashboard.QuotaOverviewCard).toBeDefined();
        expect(dashboard.ServiceActionsCard).toBeDefined();
    });

    it("re-exports file explorer components and constants", () => {
        expect(files.ConfigSection).toBeDefined();
        expect(files.CONFIG_TOP_FILES).toBeDefined();
        expect(files.FileContentViewer).toBeDefined();
        expect(files.FileEditorPanel).toBeDefined();
        expect(files.FilesSidebar).toBeDefined();
        expect(files.FileTreeItem).toBeDefined();
        expect(files.HOOKS_DIR_FILES).toBeDefined();
        expect(files.MAX_PREVIEW_SIZE).toBe(1024 * 1024);
        expect(files.PreviewToggle).toBeDefined();
    });

    it("re-exports log components", () => {
        expect(logs.LevelFilter).toBeDefined();
        expect(logs.LogLine).toBeDefined();
    });

    it("re-exports moltbook components", () => {
        expect(moltbook.FeedPostCard).toBeDefined();
        expect(moltbook.MyCommentCard).toBeDefined();
        expect(moltbook.MyPostCard).toBeDefined();
        expect(moltbook.ProfileCard).toBeDefined();
    });

    it("re-exports session helpers and table components", () => {
        const session = {
            activeRunId: null,
            agentType: "",
            channel: "",
            createdAt: null,
            currentRunId: null,
            displayLabel: "Main",
            displayName: "Main",
            hookName: "",
            id: "main",
            key: "main",
            kind: "",
            label: "main",
            maxTokens: 0,
            model: "codex",
            runId: null,
            tokenCount: 0,
            type: "MAIN",
            updatedAt: null,
        };

        expect(sessions.SESSION_TYPES).toContain("MAIN");
        expect(sessions.SessionActionsDropdown).toBeDefined();
        expect(sessions.SessionsTable).toBeDefined();
        expect(sessions.formatSessionType(session)).toBe("MAIN");
        expect(sessions.getTypeSortOrder("main")).toBe(0);
    });

    it("re-exports settings sections", () => {
        expect(settings.AgentAccessSection).toBeDefined();
        expect(settings.ChannelSection).toBeDefined();
        expect(settings.HeartbeatSection).toBeDefined();
        expect(settings.ModelSection).toBeDefined();
        expect(settings.SecuritySection).toBeDefined();
        expect(settings.SessionSection).toBeDefined();
        expect(settings.SkillsSection).toBeDefined();
        expect(settings.ToolSection).toBeDefined();
    });

    it("re-exports task components and constants", () => {
        expect(tasks.COLUMN_CONFIG).toBeDefined();
        expect(tasks.NewTaskModal).toBeDefined();
        expect(tasks.TaskCard).toBeDefined();
        expect(tasks.TaskColumn).toBeDefined();
        expect(tasks.TaskDetailModal).toBeDefined();
        expect(tasks.TaskOverlay).toBeDefined();
        expect(tasks.getColumnId("todo")).toBe("todo");
        expect(tasks.getPriority([{ name: "high" }])).toBe("high");
        expect(tasks.PRIORITY_COLORS.high).toBeDefined();
    });
});
