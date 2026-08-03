import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { requestUrl } from "../../../../test/support/fetch";
import { TaskHistorySidebar } from "../../components/features/agents/TaskHistorySidebar";
import { CronJobDetails } from "../../components/features/cron/CronJobDetails";
import { BackupOverviewCard } from "../../components/features/dashboard/BackupOverviewCard";
import { CacheStatusCard } from "../../components/features/dashboard/CacheStatusCard";
import { AutovacuumHealthTable } from "../../components/features/database/AutovacuumHealthTable";
import { DatabasesTable } from "../../components/features/database/DatabaseSizesTable";
import { DatabaseTableShell } from "../../components/features/database/DatabaseTableShell";
import { PgBouncerPoolsTable } from "../../components/features/database/PgBouncerPoolsTable";
import { PgBouncerStatsTable } from "../../components/features/database/PgBouncerStatsTable";
import { TopQueriesTable } from "../../components/features/database/TopQueriesTable";
import { FileEditorPanel } from "../../components/features/files/FileEditorPanel";
import { SessionsTable } from "../../components/features/sessions/SessionsTable";
import { AgentAccessSection } from "../../components/features/settings/AgentAccessSection";
import { ChannelSection } from "../../components/features/settings/ChannelSection";
import { HeartbeatSection } from "../../components/features/settings/HeartbeatSection";
import { ModelSection } from "../../components/features/settings/ModelSection";
import { SessionSection } from "../../components/features/settings/SessionSection";
import { SkillsSection } from "../../components/features/settings/SkillsSection";
import { ToolSection } from "../../components/features/settings/ToolSection";
const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};
function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}
function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}
beforeEach(() => {
    Object.defineProperties(globalThis, {
        requestAnimationFrame: {
            configurable: true,
            value: requestAnimationFrameForTest,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: cancelAnimationFrameForTest,
            writable: true,
        },
    });
});
afterEach(() => {
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
    });
    animationFrameState.frames.clear();
});
function renderWithQueryClient(children: ReactNode) {
    const queryClient = createQueryClient();
    return {
        ...render(
            <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
        queryClient,
    };
}
function createQueryClient() {
    return new QueryClient({
        defaultOptions: {
            mutations: {
                retry: false,
            },
            queries: {
                retry: false,
                staleTime: Infinity,
            },
        },
    });
}
describe("Dashboard settings and database components", () => {
    it("drives settings lists, task history, and file editor panel states", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn((input: RequestInfo | URL) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                if (url === "/api/agents/tasks/history?limit=7") {
                    return Response.json({
                        tasks: [
                            {
                                agentId: "mira-2026",
                                completedAt: "2026-06-24T11:00:00.000Z",
                                id: 1,
                                lastActivityAt: "2026-06-24T11:00:00.000Z",
                                startedAt: "2026-06-24T10:00:00.000Z",
                                status: "done",
                                task: "Expand tests",
                            },
                        ],
                        timestamp: 1_719_226_800_000,
                    });
                }
                throw new Error(`Unexpected settings component fetch: ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const onSaveChannels = jest.fn(async () => {});
        const onSaveAgents = jest.fn(async () => {});
        const onToggleSkill = jest.fn();
        const onSaveFile = jest.fn();
        const onRevealFile = jest.fn();
        const onContentChange = jest.fn();
        const onMarkdownPreviewChange = jest.fn();
        const onJsonPreviewChange = jest.fn();
        const onCodePreviewChange = jest.fn();
        const { queryClient, rerender } = renderWithQueryClient(
            <>
                <TaskHistorySidebar />
                <ChannelSection
                    channels={[
                        {
                            details: "direct",
                            enabled: true,
                            id: "webchat",
                            policy: "trusted",
                        },
                        {
                            enabled: false,
                            id: "discord",
                        },
                    ]}
                    onSave={onSaveChannels}
                    saving={false}
                />
                <SkillsSection
                    skills={[
                        {
                            description: "Workspace skill",
                            enabled: true,
                            name: "dashboard",
                            path: "skills.entries.dashboard",
                            source: "workspace",
                        },
                        {
                            description: "Built in skill",
                            enabled: false,
                            name: "browser",
                            path: "skills.entries.browser",
                            source: "builtin",
                        },
                        {
                            enabled: false,
                            name: "extra-tool",
                            path: "skills.entries.extra-tool",
                            source: "extra",
                        },
                    ]}
                    onToggle={onToggleSkill}
                />
                <AgentAccessSection
                    agents={[
                        {
                            id: "mira-2026",
                            name: "Mira",
                            tools: {
                                deny: ["web_search"],
                            },
                        },
                        {
                            id: "researcher",
                            name: "Researcher",
                            tools: {
                                allow: ["web_search"],
                            },
                        },
                    ]}
                    onSave={onSaveAgents}
                    saving={false}
                />
                <FileEditorPanel
                    selectedPath={undefined}
                    contentLoading={false}
                    isEditable={false}
                    hasChanges={false}
                    savePending={false}
                    editedContent=""
                    largeFileWarning={false}
                    markdownPreview={false}
                    jsonPreview={false}
                    codeEditMode={false}
                    syntaxClass=""
                    isJsonEditing={false}
                    jsonValidation={{
                        error: undefined,
                        valid: true,
                    }}
                    onSave={onSaveFile}
                    onContentChange={onContentChange}
                    onMarkdownPreviewChange={onMarkdownPreviewChange}
                    onJsonPreviewChange={onJsonPreviewChange}
                    onCodePreviewChange={onCodePreviewChange}
                />
            </>
        );
        await waitFor(() => {
            expect(screen.getByText("Expand tests")).toBeInTheDocument();
        });
        expect(screen.getByText("Select a file to view")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Channels",
            })
        );
        await user.click(screen.getByLabelText("discord"));
        await user.click(
            screen.getByRole("button", {
                name: "Save channels",
            })
        );
        expect(onSaveChannels).toHaveBeenCalledWith(
            expect.arrayContaining([
                expect.objectContaining({
                    enabled: true,
                    id: "discord",
                }),
            ])
        );
        await user.click(
            screen.getByRole("button", {
                name: "Skills",
            })
        );
        await user.type(screen.getByPlaceholderText("Search skills..."), " browser ");
        await user.click(
            screen.getByRole("button", {
                name: "disabled",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: "Built-in 1 skills",
            })
        );
        await user.click(screen.getAllByRole("switch").at(-1)!);
        expect(onToggleSkill).toHaveBeenCalledWith("browser", true);
        await user.click(
            screen.getByRole("button", {
                name: "Agent access control",
            })
        );
        await user.type(screen.getByPlaceholderText("Filter tools..."), " web search ");
        await user.click(screen.getByText("Researcher"));
        await user.click(screen.getAllByRole("switch").at(-1)!);
        await user.click(
            screen.getByRole("button", {
                name: "Save access control",
            })
        );
        const latestSaveCall = onSaveAgents.mock.calls.at(-1) as
            | [
                  Array<{
                      id: string;
                      tools?: {
                          allow?: string[];
                      };
                  }>,
              ]
            | undefined;
        const savedAgents = latestSaveCall?.[0] ?? [];
        expect(savedAgents).toContainEqual(
            expect.objectContaining({
                id: "researcher",
                tools: expect.objectContaining({
                    allow: [],
                }),
            })
        );
        rerender(
            <QueryClientProvider client={queryClient}>
                <FileEditorPanel
                    selectedPath="config:openclaw.json"
                    fileContent={{
                        content: "{bad json",
                        isBinary: false,
                        masked: true,
                        maskingError: "invalid_json",
                        modified: "",
                        path: "config:openclaw.json",
                        size: 9,
                    }}
                    contentLoading={false}
                    isEditable={true}
                    hasChanges={true}
                    savePending={false}
                    editedContent="{bad json"
                    largeFileWarning={false}
                    markdownPreview={false}
                    jsonPreview={false}
                    codeEditMode={false}
                    syntaxClass="syntax-test"
                    isJsonEditing={true}
                    jsonValidation={{
                        error: "Expected brace",
                        valid: false,
                    }}
                    onSave={onSaveFile}
                    onReveal={onRevealFile}
                    onContentChange={onContentChange}
                    onMarkdownPreviewChange={onMarkdownPreviewChange}
                    onJsonPreviewChange={onJsonPreviewChange}
                    onCodePreviewChange={onCodePreviewChange}
                />
            </QueryClientProvider>
        );
        expect(screen.getByText("Invalid JSON")).toBeInTheDocument();
        expect(
            screen.getByText(/masked preview is unavailable.*not valid JSON/i)
        ).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: "Reveal secrets",
            })
        );
        expect(onRevealFile).toHaveBeenCalledTimes(1);
        expect(
            screen.getByRole("button", {
                name: /save/i,
            })
        ).toBeDisabled();
        rerender(
            <QueryClientProvider client={queryClient}>
                <FileEditorPanel
                    selectedPath="src/readme.md"
                    fileContent={{
                        content: "# Hello",
                        isBinary: false,
                        modified: "2026-06-24T11:00:00.000Z",
                        path: "src/readme.md",
                        size: 7,
                    }}
                    contentLoading={false}
                    isEditable={true}
                    hasChanges={true}
                    savePending={true}
                    editedContent="# Hello"
                    largeFileWarning={false}
                    markdownPreview={false}
                    jsonPreview={false}
                    codeEditMode={false}
                    syntaxClass=""
                    isJsonEditing={false}
                    jsonValidation={{
                        error: undefined,
                        valid: true,
                    }}
                    onSave={onSaveFile}
                    onContentChange={onContentChange}
                    onMarkdownPreviewChange={onMarkdownPreviewChange}
                    onJsonPreviewChange={onJsonPreviewChange}
                    onCodePreviewChange={onCodePreviewChange}
                />
            </QueryClientProvider>
        );
        await user.click(
            screen.getByRole("button", {
                name: "Preview",
            })
        );
        expect(onMarkdownPreviewChange).toHaveBeenCalledWith(true);
        expect(
            screen.getByRole("button", {
                name: /saving/i,
            })
        ).toBeDisabled();
        queryClient.clear();
    });
    it("drives settings form sections through expanded save controls", async () => {
        const user = userEvent.setup();
        const onSaveHeartbeat = jest.fn(async () => {});
        const onSaveModel = jest.fn(async () => {});
        const onSaveSession = jest.fn(async () => {});
        const onSaveTools = jest.fn(async () => {});
        const heartbeatView = render(
            <HeartbeatSection
                every={300}
                target="webchat"
                onSave={onSaveHeartbeat}
                saving={false}
            />
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: /heartbeat/i,
            })
        );
        fireEvent.change(screen.getByLabelText("Interval (seconds)"), {
            target: {
                value: "600",
            },
        });
        fireEvent.change(screen.getByLabelText("Target Channel"), {
            target: {
                value: "discord",
            },
        });
        await user.click(
            screen.getByRole("button", {
                name: /^save$/i,
            })
        );
        expect(onSaveHeartbeat).toHaveBeenCalledWith(600, "discord");
        heartbeatView.unmount();
        const modelView = render(
            <ModelSection
                defaultModel="codex"
                fallbacks={["glm51"]}
                imageModel={undefined}
                imageGenerationModel="gpt-image"
                onSave={onSaveModel}
                saving={false}
            />
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: /model configuration/i,
            })
        );
        fireEvent.change(screen.getByLabelText("Default model"), {
            target: {
                value: "openai/gpt-5.5",
            },
        });
        fireEvent.change(screen.getByLabelText("Fallback models"), {
            target: {
                value: "glm51, kimi, codex-mini",
            },
        });
        await user.click(
            screen.getByRole("button", {
                name: /save model settings/i,
            })
        );
        expect(onSaveModel).toHaveBeenCalledWith({
            primary: "openai/gpt-5.5",
            fallbacks: ["glm51", "kimi", "codex-mini"],
        });
        modelView.unmount();
        const sessionView = render(
            <SessionSection idleMinutes={60} onSave={onSaveSession} saving={false} />
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: /^session$/i,
            })
        );
        fireEvent.change(screen.getByLabelText(/idle timeout/i), {
            target: {
                value: "90",
            },
        });
        await user.click(
            screen.getByRole("button", {
                name: /^save$/i,
            })
        );
        expect(onSaveSession).toHaveBeenCalledWith(90);
        sessionView.unmount();
        render(
            <ToolSection
                profile="safe"
                webSearchEnabled={false}
                webSearchProvider="brave"
                webFetchEnabled={true}
                execSecurity="allowlist"
                execAsk="on-miss"
                elevatedEnabled={false}
                agentToAgentEnabled={true}
                sessionsVisibility="owned"
                onSave={onSaveTools}
                saving={false}
            />
        );
        fireEvent.click(
            screen.getByRole("button", {
                name: /^tools$/i,
            })
        );
        fireEvent.change(screen.getByLabelText("Tool profile"), {
            target: {
                value: "full",
            },
        });
        fireEvent.change(screen.getByLabelText("Web search provider"), {
            target: {
                value: "brave-search",
            },
        });
        fireEvent.change(screen.getByLabelText("Sessions visibility"), {
            target: {
                value: "all",
            },
        });
        await user.click(
            screen.getByRole("switch", {
                name: "Web search",
            })
        );
        await user.click(
            screen.getByRole("switch", {
                name: "Elevated tools",
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /save tool settings/i,
            })
        );
        expect(onSaveTools).toHaveBeenCalledWith(
            expect.objectContaining({
                elevatedEnabled: true,
                profile: "full",
                sessionsVisibility: "all",
                webSearchEnabled: true,
                webSearchProvider: "brave-search",
            })
        );
    });
    it("drives sessions table row actions and empty state", async () => {
        const user = userEvent.setup();
        const onCompact = jest.fn();
        const onReset = jest.fn();
        const onDelete = jest.fn();
        const session = {
            agentType: "codex",
            channel: "web",
            createdAt: "2026-06-24T10:00:00.000Z",
            displayLabel: "Main Session",
            displayName: "Main Session",
            hookName: "",
            id: "session-1",
            key: "agent:main:main",
            kind: "agent",
            label: "Main",
            maxTokens: 1000,
            model: "codex",
            tokenCount: 125,
            type: "agent",
            updatedAt: Date.now(),
        };
        const { rerender } = render(
            <SessionsTable
                sessions={[]}
                emptyMessage="No cron sessions found"
                onCompact={onCompact}
                onReset={onReset}
                onDelete={onDelete}
            />
        );
        expect(screen.getByText("No cron sessions found")).toBeInTheDocument();
        await act(() => {
            return Promise.try(() => {
                rerender(
                    <SessionsTable
                        sessions={[session]}
                        onCompact={onCompact}
                        onReset={onReset}
                        onDelete={onDelete}
                    />
                );
            });
        });
        expect(screen.getAllByText("Main Session").length).toBeGreaterThan(0);
        await user.click(
            screen.getAllByRole("button", {
                name: /actions for main/i,
            })[0]!
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /compact/i,
            })
        );
        await user.click(
            screen.getAllByRole("button", {
                name: /actions for main/i,
            })[0]!
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /reset/i,
            })
        );
        await user.click(
            screen.getAllByRole("button", {
                name: /actions for main/i,
            })[0]!
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /delete/i,
            })
        );
        expect(onCompact).toHaveBeenCalledWith("agent:main:main");
        expect(onReset).toHaveBeenCalledWith("agent:main:main");
        expect(onDelete).toHaveBeenCalledWith(session);
        await act(() => {
            return Promise.try(() => {
                rerender(
                    <SessionsTable
                        sessions={[
                            {
                                ...session,
                                maxTokens: 0,
                                tokenCount: 0,
                            },
                        ]}
                        onCompact={onCompact}
                        onReset={onReset}
                        onDelete={onDelete}
                    />
                );
            });
        });
        expect(screen.getAllByText("Unknown")).toHaveLength(2);
        expect(screen.queryByText("0.0k / 200k")).not.toBeInTheDocument();
        await act(() => {
            return Promise.try(() => {
                rerender(
                    <SessionsTable
                        sessions={[
                            {
                                ...session,
                                totalTokensFresh: false,
                            },
                        ]}
                        onCompact={onCompact}
                        onReset={onReset}
                        onDelete={onDelete}
                    />
                );
            });
        });
        expect(screen.getAllByText("~0.1k / 1k (stale)")).toHaveLength(2);
        expect(screen.queryByText("13%")).not.toBeInTheDocument();
        expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    });
    it("drives cron job details controls and edit form", async () => {
        const user = userEvent.setup();
        const job = {
            delivery: {
                mode: "webhook",
            },
            enabled: true,
            id: "heartbeat",
            name: "Heartbeat",
            payload: {
                kind: "ping",
            },
            schedule: {
                kind: "interval",
                seconds: 60,
            },
            state: {
                lastRunAtMs: 1_719_216_000_000,
                lastRunStatus: "success",
                nextRunAtMs: 1_719_219_600_000,
            },
        };
        const onToggle = jest.fn();
        const onConfigureDisable = jest.fn();
        const onRunNow = jest.fn();
        const onDelete = jest.fn();
        const onEditModeChange = jest.fn();
        const onNameDraftChange = jest.fn();
        const onScheduleDraftChange = jest.fn();
        const onPayloadDraftChange = jest.fn();
        const onDeliveryDraftChange = jest.fn();
        const onSave = jest.fn();
        const { rerender } = render(
            <CronJobDetails
                job={job}
                lastTriggeredAt={1_719_216_000_000}
                togglePending={false}
                runPending={false}
                updatePending={false}
                deletePending={false}
                onToggle={onToggle}
                onConfigureDisable={onConfigureDisable}
                onRunNow={onRunNow}
                onDelete={onDelete}
                isEditMode={false}
                onEditModeChange={onEditModeChange}
                nameDraft="Heartbeat"
                onNameDraftChange={onNameDraftChange}
                scheduleDraft="{}"
                onScheduleDraftChange={onScheduleDraftChange}
                payloadDraft="{}"
                onPayloadDraftChange={onPayloadDraftChange}
                deliveryDraft="{}"
                onDeliveryDraftChange={onDeliveryDraftChange}
                scheduleValidation={{
                    error: undefined,
                    valid: true,
                }}
                payloadValidation={{
                    error: undefined,
                    valid: true,
                }}
                deliveryValidation={{
                    error: undefined,
                    valid: true,
                }}
                hasInvalidJson={false}
                editError={undefined}
                onSave={onSave}
                formatDate={(value) => `date:${value}`}
            />
        );
        await user.click(
            screen.getByRole("switch", {
                name: /enabled/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /trigger now/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /delete/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /edit/i,
            })
        );
        expect(onToggle).toHaveBeenCalledWith(job, false);
        expect(onRunNow).toHaveBeenCalledWith(job);
        expect(onDelete).toHaveBeenCalledWith(job);
        expect(onEditModeChange).toHaveBeenCalledWith(true);
        const disabledJob = {
            ...job,
            enabled: false,
            disableIntent: {
                mode: "indefinite" as const,
                comment: "Paused during chat work",
            },
        };
        rerender(
            <CronJobDetails
                job={disabledJob}
                lastTriggeredAt={undefined}
                togglePending={false}
                runPending={true}
                updatePending={false}
                deletePending={false}
                onToggle={onToggle}
                onConfigureDisable={onConfigureDisable}
                onRunNow={onRunNow}
                onDelete={onDelete}
                isEditMode={true}
                onEditModeChange={onEditModeChange}
                nameDraft="Heartbeat"
                onNameDraftChange={onNameDraftChange}
                scheduleDraft="{bad"
                onScheduleDraftChange={onScheduleDraftChange}
                payloadDraft="{}"
                onPayloadDraftChange={onPayloadDraftChange}
                deliveryDraft="{}"
                onDeliveryDraftChange={onDeliveryDraftChange}
                scheduleValidation={{
                    error: "bad",
                    valid: false,
                }}
                payloadValidation={{
                    error: undefined,
                    valid: true,
                }}
                deliveryValidation={{
                    error: undefined,
                    valid: true,
                }}
                hasInvalidJson={true}
                editError="Save failed"
                onSave={onSave}
                formatDate={(value) => `date:${value}`}
            />
        );
        fireEvent.change(screen.getByLabelText("Name"), {
            target: {
                value: "New heartbeat",
            },
        });
        fireEvent.change(screen.getByLabelText("Schedule (JSON)"), {
            target: {
                value: '{"kind":"daily"}',
            },
        });
        fireEvent.change(screen.getByLabelText("Payload (JSON)"), {
            target: {
                value: '{"ok":true}',
            },
        });
        fireEvent.change(screen.getByLabelText("Delivery (JSON)"), {
            target: {
                value: '{"mode":"webhook"}',
            },
        });
        await user.click(
            screen.getByRole("button", {
                name: /cancel/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /save edits/i,
            })
        );
        expect(onNameDraftChange).toHaveBeenCalledWith("New heartbeat");
        expect(onScheduleDraftChange).toHaveBeenCalledWith('{"kind":"daily"}');
        expect(onPayloadDraftChange).toHaveBeenCalledWith('{"ok":true}');
        expect(onDeliveryDraftChange).toHaveBeenCalledWith('{"mode":"webhook"}');
        expect(onEditModeChange).toHaveBeenCalledWith(false);
        expect(onSave).not.toHaveBeenCalled();
        expect(screen.getByText("Invalid JSON: bad")).toBeInTheDocument();
        expect(screen.getByText("Save failed")).toBeInTheDocument();
        expect(screen.getByText("Running job...")).toBeInTheDocument();
        expect(screen.getByText("Paused during chat work")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /edit disabled reason/i,
            })
        );
        expect(onConfigureDisable).toHaveBeenCalledWith(disabledJob);
    });
    it("drives database table shells, autovacuum cards, and top query modal copy", async () => {
        const user = userEvent.setup();
        const onRowClick = jest.fn();
        const writeText = jest.fn(async () => {});
        const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "clipboard"
        );
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                writeText,
            },
        });
        try {
            const { rerender } = render(
                <DatabaseTableShell
                    data={[]}
                    columns={[]}
                    emptyMessage="Nothing here"
                    onRowClick={onRowClick}
                />
            );
            expect(screen.getByText("Nothing here")).toBeInTheDocument();
            rerender(
                <AutovacuumHealthTable
                    data={[
                        {
                            dead_pct: "12.5",
                            last_autoanalyze: "",
                            last_autovacuum: "",
                            n_dead_tup: "42",
                            n_live_tup: "100",
                            relname: "tasks",
                            schemaname: "public",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("public.tasks").length).toBeGreaterThan(0);
            expect(screen.getAllByText("12.5%").length).toBeGreaterThan(0);
            rerender(
                <PgBouncerPoolsTable
                    data={[
                        {
                            cl_active: "2",
                            cl_waiting: "1",
                            database: "mira",
                            maxwait: "0",
                            pool_mode: "transaction",
                            sv_active: "1",
                            sv_idle: "2",
                            sv_used: "3",
                            user: "dashboard",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("dashboard").length).toBeGreaterThan(0);
            expect(screen.getAllByText("6").length).toBeGreaterThan(0);
            rerender(
                <PgBouncerStatsTable
                    data={[
                        {
                            avg_query_time: "1.2",
                            avg_xact_time: "3.4",
                            database: "mira",
                            total_query_time: "50",
                            total_query_count: "42",
                            total_received: "100",
                            total_sent: "200",
                            total_xact_count: "21",
                            total_xact_time: "30",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("Avg query").length).toBeGreaterThan(0);
            expect(screen.getAllByText("42").length).toBeGreaterThan(0);
            rerender(
                <DatabasesTable
                    databases={[
                        {
                            blks_hit: "999",
                            blks_read: "1",
                            cache_hit_ratio: "99.9",
                            datname: "dashboard",
                            numbackends: "1",
                            size_bytes: "1048576",
                            size_pretty: "1024 kB",
                            xact_commit: "100",
                            xact_rollback: "0",
                        },
                    ]}
                    pools={[
                        {
                            cl_active: "2",
                            cl_waiting: "1",
                            database: "dashboard",
                            maxwait: "0",
                            pool_mode: "transaction",
                            sv_active: "1",
                            sv_idle: "2",
                            sv_used: "0",
                            user: "dashboard",
                        },
                        {
                            cl_active: "3",
                            cl_waiting: "2",
                            database: "dashboard",
                            maxwait: "0",
                            pool_mode: "transaction",
                            sv_active: "2",
                            sv_idle: "1",
                            sv_used: "1",
                            user: "worker",
                        },
                        {
                            cl_active: "invalid",
                            cl_waiting: "invalid",
                            database: "dashboard",
                            maxwait: "invalid",
                            pool_mode: "transaction",
                            sv_active: "invalid",
                            sv_idle: "invalid",
                            sv_used: "invalid",
                            user: "malformed",
                        },
                    ]}
                    stats={[
                        {
                            avg_query_time: "1.2",
                            avg_xact_time: "3.4",
                            database: "dashboard",
                            total_query_count: "1234567",
                            total_query_time: "50",
                            total_received: "100",
                            total_sent: "200",
                            total_xact_count: "21",
                            total_xact_time: "30",
                        },
                    ]}
                />
            );
            expect(screen.getAllByText("1,234,567").length).toBeGreaterThan(0);
            expect(screen.getAllByText("5 / 3 / 3").length).toBeGreaterThan(0);
            expect(screen.queryByText("NaN")).not.toBeInTheDocument();
            rerender(<TopQueriesTable enabled={false} data={[]} />);
            expect(
                screen.getByText("pg_stat_statements is not enabled.")
            ).toBeInTheDocument();
            const query = "select * from task_history where agent_id = 'mira-2026'";
            rerender(
                <TopQueriesTable
                    enabled={true}
                    data={[
                        {
                            calls: "7",
                            mean_exec_time: "2.5",
                            query,
                            rows: "3",
                            shared_blks_hit: "10",
                            shared_blks_read: "1",
                            total_exec_time: "17.5",
                        },
                    ]}
                />
            );
            await user.click(screen.getAllByText(/select \*/i)[0]!);
            expect(screen.getByText("Query details")).toBeInTheDocument();
            await user.click(
                screen.getByRole("button", {
                    name: /copy query/i,
                })
            );
            expect(writeText).toHaveBeenCalledWith(query);
            expect(
                await screen.findByRole("button", {
                    name: /copied/i,
                })
            ).toBeInTheDocument();
        } finally {
            if (originalClipboardDescriptor) {
                Object.defineProperty(
                    navigator,
                    "clipboard",
                    originalClipboardDescriptor
                );
            } else {
                delete (
                    navigator as {
                        clipboard?: Clipboard;
                    }
                ).clipboard;
            }
        }
    });
    it("drives backup overview attention, clear, and run actions", async () => {
        const user = userEvent.setup();
        let mode: "attention" | "idle" = "attention";
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (method === "POST") {
                    const type = url.includes("/walg/") ? "walg" : "kopia";
                    const job = {
                        code: 0,
                        endedAt: 1_719_216_010_000,
                        id: `${type}-${url.endsWith("/run") ? "started" : "cleared"}`,
                        startedAt: 1_719_216_000_000,
                        status: "done",
                        stderr: "",
                        stdout: "",
                        type,
                    };
                    return url.endsWith("/clear-needs-attention")
                        ? Response.json({
                              cleared: job,
                              isOk: true,
                          })
                        : Response.json({
                              isOk: true,
                              job,
                          });
                }
                if (url === "/api/backups/kopia" || url === "/api/backups/walg") {
                    const type = url.endsWith("walg") ? "walg" : "kopia";
                    return Response.json({
                        job:
                            mode === "attention"
                                ? {
                                      code: 1,
                                      endedAt: 1_719_216_010_000,
                                      id: `${type}-attention`,
                                      startedAt: 1_719_216_000_000,
                                      status: "needs_attention",
                                      stderr: `${type} stderr`,
                                      stdout: "",
                                      type,
                                  }
                                : {
                                      code: 0,
                                      endedAt: 1_719_216_010_000,
                                      id: `${type}-done`,
                                      startedAt: 1_719_216_000_000,
                                      status: "done",
                                      stderr: "",
                                      stdout: "",
                                      type,
                                  },
                    });
                }
                if (url === "/api/cache/backup.kopia.status") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            checkedAt: "2026-06-24T08:00:00.000Z",
                            isOk: mode === "idle",
                            latest: [],
                            snapshotsByPath: [
                                {
                                    latest: undefined,
                                    path: "/source/docker",
                                    snapshotCount: 2,
                                    snapshots: [
                                        {
                                            description: "Daily Docker backup",
                                            endTime: "2026-06-24T08:00:00.000Z",
                                            errorCount: 0,
                                            fileCount: 12,
                                            id: "snap-1",
                                            ignoredErrorCount: 0,
                                            path: "/source/docker",
                                            retentionReason: ["daily"],
                                            startTime: "2026-06-24T07:59:00.000Z",
                                            totalSize: 2048,
                                        },
                                        {
                                            description: undefined,
                                            endTime: undefined,
                                            errorCount: undefined,
                                            fileCount: undefined,
                                            id: undefined,
                                            ignoredErrorCount: undefined,
                                            path: "/source/projects",
                                            retentionReason: [],
                                            startTime: undefined,
                                            totalSize: undefined,
                                        },
                                    ],
                                },
                            ],
                            stale: [
                                {
                                    path: "/source/docker",
                                },
                            ],
                            tool: "kopia",
                        },
                        errorCode: null,
                        errorMessage: null,
                        expiresAt: null,
                        key: "backup.kopia.status",
                        lastAttemptAt: null,
                        meta: {},
                        source: "backup",
                        status: mode === "idle" ? "fresh" : "stale",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    });
                }
                if (url === "/api/cache/backup.walg.status") {
                    return Response.json({
                        consecutiveFailures: 0,
                        data: {
                            backupCount: 3,
                            backups: [],
                            checkedAt: "2026-06-24T08:00:00.000Z",
                            isOk: mode === "idle",
                            latest: {
                                backupName: "base_0001",
                                modified: "2026-06-24T08:00:00.000Z",
                                walFileName: "000000010000000000000001",
                            },
                            stale: mode !== "idle",
                            tool: "wal-g",
                        },
                        errorCode: null,
                        errorMessage: null,
                        expiresAt: null,
                        key: "backup.walg.status",
                        lastAttemptAt: null,
                        meta: {},
                        source: "backup",
                        status: mode === "idle" ? "fresh" : "stale",
                        updatedAt: "2026-06-24T08:00:00.000Z",
                    });
                }
                throw new Error(`Unexpected backup test fetch: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const attentionView = renderWithQueryClient(<BackupOverviewCard />);
        expect(await screen.findByText("Backup needs attention")).toBeInTheDocument();
        expect(screen.getByText("Postgres backup needs attention")).toBeInTheDocument();
        expect(screen.getByText("Daily Docker backup")).toBeInTheDocument();
        expect(screen.getByText("Stale")).toBeInTheDocument();
        expect(screen.getByText("2.0 KB")).toBeInTheDocument();
        const clearButtons = screen.getAllByRole("button", {
            name: /clear attention/i,
        });
        await user.click(clearButtons[0]!);
        await user.click(clearButtons[1]!);
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/backups/walg/clear-needs-attention",
            expect.objectContaining({
                method: "POST",
            })
        );
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/backups/kopia/clear-needs-attention",
            expect.objectContaining({
                method: "POST",
            })
        );
        attentionView.unmount();
        attentionView.queryClient.clear();
        mode = "idle";
        const idleView = renderWithQueryClient(<BackupOverviewCard />);
        expect(await screen.findByText("base_0001")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /run postgres backup/i,
            })
        );
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/backups/walg/run",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        await user.click(
            screen.getByRole("button", {
                name: /run filesystem backup/i,
            })
        );
        expect(screen.getByText("Run backup now")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /^run backup$/i,
            })
        );
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/backups/kopia/run",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        idleView.unmount();
        idleView.queryClient.clear();
    });
    it("labels cache refresh controls by entry and refreshes grouped keys", async () => {
        const user = userEvent.setup();
        const fetchMock = jest.fn((input: RequestInfo | URL, init?: RequestInit) => {
            return Promise.try(() => {
                const url = requestUrl(input);
                const method = init?.method ?? "GET";
                if (url === "/api/cache/status" && method === "GET") {
                    return Response.json({
                        count: 2,
                        entries: [
                            {
                                consecutiveFailures: 0,
                                data: {},
                                errorCode: undefined,
                                errorMessage: undefined,
                                expiresAt: undefined,
                                key: "weather.spydeberg",
                                lastAttemptAt: undefined,
                                meta: {},
                                source: "weather",
                                status: "fresh",
                                updatedAt: "2026-06-24T08:00:00.000Z",
                            },
                            {
                                consecutiveFailures: 0,
                                data: {},
                                errorCode: undefined,
                                errorMessage: undefined,
                                expiresAt: undefined,
                                key: "moltbook.home",
                                lastAttemptAt: undefined,
                                meta: {},
                                source: "moltbook",
                                status: "stale",
                                updatedAt: "2026-06-24T07:00:00.000Z",
                            },
                        ],
                        generatedAt: "2026-06-24T08:01:00.000Z",
                    });
                }
                if (url.startsWith("/api/cache/") && url.endsWith("/refresh")) {
                    return Response.json({
                        entry: {
                            key: decodeURIComponent(
                                url.replace("/api/cache/", "").replace("/refresh", "")
                            ),
                        },
                        isOk: true,
                    });
                }
                throw new Error(`Unexpected cache card fetch: ${method} ${url}`);
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });
        const view = renderWithQueryClient(
            <CacheStatusCard
                title="Cache controls"
                items={[
                    {
                        key: "weather.spydeberg",
                        label: "Weather",
                    },
                    {
                        key: "moltbook.home",
                        label: "Moltbook",
                        refreshKeys: ["moltbook.home", "moltbook.feed.hot"],
                    },
                ]}
            />
        );
        const weatherRefresh = await screen.findByRole("button", {
            name: /force update weather/i,
        });
        expect(
            screen.getByRole("button", {
                name: /force update moltbook/i,
            })
        ).toHaveAttribute("title", "Force update Moltbook");
        await user.click(weatherRefresh);
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/weather.spydeberg/refresh",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        await user.click(
            screen.getByRole("button", {
                name: /force update moltbook/i,
            })
        );
        await waitFor(() => {
            expect(fetchMock).toHaveBeenCalledWith(
                "/api/cache/moltbook.home/refresh",
                expect.objectContaining({
                    method: "POST",
                })
            );
        });
        expect(fetchMock).toHaveBeenCalledWith(
            "/api/cache/moltbook.feed.hot/refresh",
            expect.objectContaining({
                method: "POST",
            })
        );
        view.unmount();
        view.queryClient.clear();
    });
});
