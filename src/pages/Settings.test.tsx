import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
    configuredChannels,
    numberFromDuration,
    patchSuccess,
    Settings,
} from "./Settings";

const hooks = vi.hoisted(() => ({
    createBackup: vi.fn(),
    createObjectUrl: vi.fn(() => "blob:backup"),
    restartGateway: vi.fn(),
    revokeObjectUrl: vi.fn(),
    toggleSkill: vi.fn(),
    updateConfig: vi.fn(),
    useCacheEntry: vi.fn(),
    useConfig: vi.fn(),
    useCreateBackup: vi.fn(),
    useRestartGateway: vi.fn(),
    useSkills: vi.fn(),
    useToggleSkill: vi.fn(),
    useUpdateConfig: vi.fn(),
}));

vi.mock("../hooks", () => ({
    useCacheEntry: hooks.useCacheEntry,
    useConfig: hooks.useConfig,
    useCreateBackup: hooks.useCreateBackup,
    useRestartGateway: hooks.useRestartGateway,
    useSkills: hooks.useSkills,
    useToggleSkill: hooks.useToggleSkill,
    useUpdateConfig: hooks.useUpdateConfig,
}));

vi.mock("../components/ui/Modal", () => ({
    Modal: ({
        children,
        isOpen,
        title,
    }: {
        children: React.ReactNode;
        isOpen: boolean;
        title: string;
    }) =>
        isOpen ? (
            <section data-testid="modal">
                <h2>{title}</h2>
                {children}
            </section>
        ) : null,
}));

vi.mock("../components/features/settings", () => ({
    AgentAccessSection: ({
        agents,
        onSave,
    }: {
        agents: unknown[];
        onSave: (agents: unknown[]) => Promise<void>;
    }) => (
        <section data-testid="agent-access-section">
            agents: {agents.length}
            <button type="button" onClick={() => void onSave([{ id: "main" }])}>
                Save agent access
            </button>
        </section>
    ),
    ChannelSection: ({
        channels,
        onSave,
    }: {
        channels: Array<{ enabled: boolean; id: string }>;
        onSave: (channels: Array<{ enabled: boolean; id: string }>) => Promise<void>;
    }) => (
        <section data-testid="channel-section">
            channels: {channels.map((channel) => channel.id).join(",")}
            <button
                type="button"
                onClick={() => void onSave([{ enabled: false, id: "discord" }])}
            >
                Save channels
            </button>
        </section>
    ),
    HeartbeatSection: ({
        every,
        onSave,
        target,
    }: {
        every: number;
        onSave: (every: number, target: string) => Promise<void>;
        target: string;
    }) => (
        <section data-testid="heartbeat-section">
            heartbeat: {every}:{target}
            <button type="button" onClick={() => void onSave(1800, "ops-check")}>
                Save heartbeat
            </button>
        </section>
    ),
    ModelSection: ({
        defaultModel,
        fallbacks,
        onSave,
    }: {
        defaultModel: string;
        fallbacks: string[];
        onSave: (values: { fallbacks: string[]; primary: string }) => Promise<void>;
    }) => (
        <section data-testid="model-section">
            model: {defaultModel}; fallbacks: {fallbacks.join(",")}
            <button
                type="button"
                onClick={() => void onSave({ fallbacks: ["kimi"], primary: "codex" })}
            >
                Save model
            </button>
        </section>
    ),
    SecuritySection: ({ execSecurity }: { execSecurity: string }) => (
        <section data-testid="security-section">security: {execSecurity}</section>
    ),
    SessionSection: ({
        idleMinutes,
        onSave,
    }: {
        idleMinutes: number;
        onSave: (idleMinutes: number) => Promise<void>;
    }) => (
        <section data-testid="session-section">
            idle: {idleMinutes}
            <button type="button" onClick={() => void onSave(45)}>
                Save session
            </button>
        </section>
    ),
    SkillsSection: ({
        onToggle,
        skills,
    }: {
        onToggle: (name: string, enabled: boolean) => Promise<void>;
        skills: Array<{ name: string }>;
    }) => (
        <section data-testid="skills-section">
            skills: {skills.map((skill) => skill.name).join(",")}
            <button type="button" onClick={() => void onToggle("weather", false)}>
                Toggle skill
            </button>
        </section>
    ),
    ToolSection: ({
        onSave,
        profile,
    }: {
        onSave: (values: {
            agentToAgentEnabled: boolean;
            elevatedEnabled: boolean;
            execAsk: string;
            execSecurity: string;
            profile: string;
            sessionsVisibility: string;
            webFetchEnabled: boolean;
            webSearchEnabled: boolean;
            webSearchProvider: string;
        }) => Promise<void>;
        profile: string;
    }) => (
        <section data-testid="tool-section">
            tools: {profile}
            <button
                type="button"
                onClick={() =>
                    void onSave({
                        agentToAgentEnabled: true,
                        elevatedEnabled: false,
                        execAsk: "always",
                        execSecurity: "deny",
                        profile: "safe",
                        sessionsVisibility: "all",
                        webFetchEnabled: true,
                        webSearchEnabled: true,
                        webSearchProvider: "brave",
                    })
                }
            >
                Save tools
            </button>
        </section>
    ),
}));

function mockSettings(overrides = {}) {
    hooks.useConfig.mockReturnValue({
        data: {
            __hash: "abcdef1234567890",
            agents: {
                defaults: {
                    model: { fallbacks: ["glm"], primary: "codex" },
                },
                list: [
                    {
                        heartbeat: { every: "30m", target: "main" },
                        id: "ops",
                    },
                ],
            },
            auth: { profiles: { owner: {} } },
            channels: { discord: { enabled: true, groupPolicy: "mention" } },
            commands: { ownerAllowFrom: ["raymond"], restart: true },
            logging: { redactSensitive: "auto" },
            meta: {
                lastTouchedAt: "2026-05-11T00:00:00.000Z",
                lastTouchedVersion: "2026.5.4",
            },
            session: { reset: { idleMinutes: 30 } },
            tools: {
                exec: { ask: "on-miss", security: "deny" },
                profile: "default",
                web: { fetch: { enabled: true }, search: { provider: "brave" } },
            },
        },
        isLoading: false,
    });
    hooks.useSkills.mockReturnValue({ data: [{ name: "weather" }], isLoading: false });
    hooks.useCacheEntry.mockReturnValue({
        data: { data: { version: { current: "2026.5.5" } } },
    });

    for (const [key, value] of Object.entries(overrides)) {
        if (key === "config") hooks.useConfig.mockReturnValue(value);
        if (key === "skills") hooks.useSkills.mockReturnValue(value);
        if (key === "systemHost") hooks.useCacheEntry.mockReturnValue(value);
    }
}

describe("Settings helpers", () => {
    it("derives channels and durations from config variants", () => {
        expect(configuredChannels()).toEqual([]);
        expect(
            configuredChannels({
                channels: {
                    signal: { allowFrom: ["raymond"], dmPolicy: "allow" },
                    discord: { botId: "bot-1", enabled: true, groupPolicy: "mention" },
                    webchat: { enabled: false },
                },
            } as never)
        ).toEqual([
            {
                details: "bot-1",
                enabled: true,
                id: "discord",
                policy: "group: mention",
            },
            {
                details: "1 allowed senders",
                enabled: false,
                id: "signal",
                policy: "dm: allow",
            },
            {
                details: undefined,
                enabled: false,
                id: "webchat",
                policy: undefined,
            },
        ]);

        expect(numberFromDuration(42, 5)).toBe(42);
        expect(numberFromDuration(null, 5)).toBe(5);
        expect(numberFromDuration("bad", 5)).toBe(5);
        expect(numberFromDuration("2h", 5)).toBe(7200);
        expect(numberFromDuration("3d", 5)).toBe(259200);
        expect(numberFromDuration("15", 5)).toBe(15);
    });

    it("clears success messages after the timeout", () => {
        vi.useFakeTimers();
        try {
            const setSuccess = vi.fn();

            patchSuccess(setSuccess, "Saved");
            expect(setSuccess).toHaveBeenCalledWith("Saved");

            vi.advanceTimersByTime(3000);
            expect(setSuccess).toHaveBeenLastCalledWith(null);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("Settings page", () => {
    beforeEach(() => {
        hooks.createBackup.mockResolvedValue({ ok: true });
        hooks.restartGateway.mockResolvedValue(Promise.resolve());
        hooks.toggleSkill.mockResolvedValue(Promise.resolve());
        hooks.updateConfig.mockResolvedValue(Promise.resolve());
        hooks.useCacheEntry.mockReset();
        hooks.useConfig.mockReset();
        hooks.useCreateBackup.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.createBackup,
        });
        hooks.useRestartGateway.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.restartGateway,
        });
        hooks.useSkills.mockReset();
        hooks.useToggleSkill.mockReturnValue({ mutateAsync: hooks.toggleSkill });
        hooks.useUpdateConfig.mockReturnValue({
            isPending: false,
            mutateAsync: hooks.updateConfig,
        });
        hooks.createObjectUrl.mockClear();
        hooks.revokeObjectUrl.mockClear();
        vi.stubGlobal("URL", {
            createObjectURL: hooks.createObjectUrl,
            revokeObjectURL: hooks.revokeObjectUrl,
        });
        HTMLAnchorElement.prototype.click = vi.fn();
        mockSettings();
    });

    it("renders loading state and derived settings sections", () => {
        const { rerender } = render(<Settings />);

        expect(screen.getByTestId("model-section")).toHaveTextContent("model: codex");
        expect(screen.getByTestId("channel-section")).toHaveTextContent(
            "channels: discord"
        );
        expect(screen.getByTestId("tool-section")).toHaveTextContent("tools: default");
        expect(screen.getByTestId("security-section")).toHaveTextContent(
            "security: deny"
        );
        expect(screen.getByTestId("session-section")).toHaveTextContent("idle: 30");
        expect(screen.getByTestId("heartbeat-section")).toHaveTextContent(
            "heartbeat: 1800:main"
        );
        expect(screen.getByTestId("skills-section")).toHaveTextContent("skills: weather");
        expect(screen.getByTestId("agent-access-section")).toHaveTextContent("agents: 1");
        expect(screen.getByText("2026.5.5")).toBeInTheDocument();
        expect(screen.getByText("abcdef123456…")).toBeInTheDocument();

        mockSettings({
            config: { data: undefined, isLoading: true },
            skills: { data: [], isLoading: true },
        });
        rerender(<Settings />);
        expect(document.querySelector(".animate-spin")).toBeInTheDocument();
    });

    it("backs up config and confirms gateway restart", async () => {
        const user = userEvent.setup();

        render(<Settings />);

        await user.click(screen.getByRole("button", { name: "Backup" }));
        expect(hooks.createBackup).toHaveBeenCalledTimes(1);
        expect(hooks.createObjectUrl).toHaveBeenCalledTimes(1);
        expect(hooks.revokeObjectUrl).toHaveBeenCalledWith("blob:backup");

        await user.click(screen.getByRole("button", { name: "Restart" }));
        expect(screen.getByTestId("modal")).toHaveTextContent("Restart Gateway");
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(screen.queryByTestId("modal")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Restart" }));
        await user.click(screen.getAllByRole("button", { name: "Restart" }).at(-1)!);
        expect(hooks.restartGateway).toHaveBeenCalledTimes(1);
    });

    it("saves section updates with expected config patches", async () => {
        const user = userEvent.setup();

        render(<Settings />);

        await user.click(screen.getByRole("button", { name: "Save model" }));
        await user.click(screen.getByRole("button", { name: "Save channels" }));
        await user.click(screen.getByRole("button", { name: "Save tools" }));
        await user.click(screen.getByRole("button", { name: "Save session" }));
        await user.click(screen.getByRole("button", { name: "Save heartbeat" }));
        await user.click(screen.getByRole("button", { name: "Save agent access" }));
        await user.click(screen.getByRole("button", { name: "Toggle skill" }));

        expect(hooks.updateConfig).toHaveBeenCalledWith({
            agents: { defaults: { model: { fallbacks: ["kimi"], primary: "codex" } } },
        });
        expect(hooks.updateConfig).toHaveBeenCalledWith({
            channels: { discord: { enabled: false } },
        });
        expect(hooks.updateConfig).toHaveBeenCalledWith(
            expect.objectContaining({ session: { reset: { idleMinutes: 45 } } })
        );
        expect(hooks.updateConfig).toHaveBeenCalledWith(
            expect.objectContaining({ agents: { list: [{ id: "main" }] } })
        );
        expect(hooks.toggleSkill).toHaveBeenCalledWith({
            name: "weather",
            enabled: false,
        });
    });

    it("shows errors from failed saves and can dismiss them", async () => {
        const user = userEvent.setup();
        hooks.updateConfig.mockRejectedValueOnce(new Error("Patch failed"));

        render(<Settings />);

        await user.click(screen.getByRole("button", { name: "Save session" }));
        expect(await screen.findByText("Patch failed")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "×" }));
        await waitFor(() => {
            expect(screen.queryByText("Patch failed")).not.toBeInTheDocument();
        });
    });

    it("renders fallback config and pending labels", () => {
        mockSettings({
            config: {
                data: {
                    agents: { defaultModel: "fallback-model", fallbacks: ["glm"] },
                    heartbeat: { every: "90s", target: "" },
                    session: { reset: {} },
                    tools: {
                        exec: { mode: "allowlist" },
                        web: { fetch: { enabled: false }, search: { enabled: false } },
                    },
                    wizard: {
                        lastRunAt: "2026-05-01T00:00:00.000Z",
                        lastRunVersion: "2026.5.1",
                    },
                },
                isLoading: false,
            },
            systemHost: { data: { data: { version: {} } } },
        });
        hooks.useCreateBackup.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.createBackup,
        });
        hooks.useRestartGateway.mockReturnValue({
            isPending: true,
            mutateAsync: hooks.restartGateway,
        });

        render(<Settings />);

        expect(screen.getByTestId("model-section")).toHaveTextContent(
            "model: fallback-model"
        );
        expect(screen.getByTestId("heartbeat-section")).toHaveTextContent(
            "heartbeat: 90:"
        );
        expect(screen.getByTestId("security-section")).toHaveTextContent(
            "security: allowlist"
        );
        expect(screen.getByText("2026.5.1")).toBeInTheDocument();
        expect(screen.getByText("Unknown")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: /Backing up/u })).toBeDisabled();
    });

    it("shows backup, restart, skill, and section-specific errors", async () => {
        const user = userEvent.setup();
        hooks.createBackup.mockRejectedValueOnce("backup failed");
        hooks.restartGateway.mockRejectedValueOnce("restart failed");
        hooks.toggleSkill.mockRejectedValueOnce("skill failed");
        hooks.updateConfig
            .mockRejectedValueOnce("model failed")
            .mockRejectedValueOnce(new Error("Tool patch failed"))
            .mockRejectedValueOnce(new Error("Channel patch failed"));

        render(<Settings />);

        await user.click(screen.getByRole("button", { name: "Backup" }));
        expect(await screen.findByText("Failed to backup")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Restart" }));
        await user.click(screen.getAllByRole("button", { name: "Restart" }).at(-1)!);
        expect(await screen.findByText("Failed to restart")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Toggle skill" }));
        expect(await screen.findByText("Failed to update skill")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save model" }));
        expect(await screen.findByText("Failed to save")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save tools" }));
        expect(await screen.findByText("Tool patch failed")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Save channels" }));
        expect(await screen.findByText("Channel patch failed")).toBeInTheDocument();
    });
});
