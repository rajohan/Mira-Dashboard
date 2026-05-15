import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Session } from "../../../types/session";
import { ChatHeader } from "./ChatHeader";

const session: Session = {
    agentType: "main",
    channel: "webchat",
    createdAt: "2026-05-10T10:00:00.000Z",
    displayLabel: "Main",
    displayName: "Main session",
    hookName: "",
    id: "session-1",
    key: "agent:main:main",
    kind: "direct",
    label: "main",
    maxTokens: 100_000,
    model: "codex",
    thinkingLevel: "high",
    tokenCount: 1234,
    type: "agent",
    updatedAt: Date.now() - 60_000,
};

describe("ChatHeader", () => {
    it("renders empty state and diagnostic toggles", async () => {
        const user = userEvent.setup();
        const onToggleThinking = vi.fn();
        const onToggleTools = vi.fn();
        const onToggleLiveToolOutput = vi.fn();

        render(
            <ChatHeader
                selectedSession={null}
                selectedSessionKey=""
                sessionOptions={[{ label: "Main", value: "agent:main:main" }]}
                agentOptions={[]}
                showThinking={false}
                showTools
                liveToolOutput={false}
                onToggleThinking={onToggleThinking}
                onToggleTools={onToggleTools}
                onToggleLiveToolOutput={onToggleLiveToolOutput}
                onSelectSession={vi.fn()}
            />
        );

        expect(screen.getByText("Choose a session to begin")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Thinking" })).toHaveAttribute(
            "aria-pressed",
            "false"
        );
        expect(screen.getByRole("button", { name: "Tools" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
        expect(screen.getByRole("button", { name: "Live output" })).toBeDisabled();

        await user.click(screen.getByRole("button", { name: "Thinking" }));
        await user.click(screen.getByRole("button", { name: "Tools" }));

        expect(onToggleThinking).toHaveBeenCalledTimes(1);
        expect(onToggleTools).toHaveBeenCalledTimes(1);
        expect(onToggleLiveToolOutput).not.toHaveBeenCalled();
    });

    it("renders selected session metadata and session selectors", async () => {
        const user = userEvent.setup();
        const onSelectSession = vi.fn();
        const onToggleLiveToolOutput = vi.fn();

        render(
            <ChatHeader
                selectedSession={{ ...session, verboseLevel: "full" }}
                selectedSessionKey="agent:main:main"
                sessionOptions={[
                    { label: "Main", value: "agent:main:main" },
                    { label: "Scratch", value: "scratch" },
                ]}
                agentOptions={[{ label: "Coder", value: "agent:coder:main" }]}
                showThinking
                showTools={false}
                liveToolOutput
                onToggleThinking={vi.fn()}
                onToggleTools={vi.fn()}
                onToggleLiveToolOutput={onToggleLiveToolOutput}
                onSelectSession={onSelectSession}
            />
        );

        expect(screen.getByText(/codex/u)).toBeInTheDocument();
        expect(screen.getByText(/Thinking: high/u)).toBeInTheDocument();
        expect(screen.getByText(/Verbose: full/u)).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Live output" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );

        await user.click(screen.getByRole("button", { name: /Main/u }));
        await user.click(await screen.findByRole("menuitem", { name: "Scratch" }));
        await user.click(screen.getByRole("button", { name: /Jump to agent/u }));
        await user.click(await screen.findByRole("menuitem", { name: "Coder" }));
        await user.click(screen.getByRole("button", { name: "Live output" }));

        expect(onSelectSession).toHaveBeenNthCalledWith(1, "scratch");
        expect(onSelectSession).toHaveBeenNthCalledWith(2, "agent:coder:main");
        expect(onToggleLiveToolOutput).toHaveBeenCalledTimes(1);
    });

    it("renders unknown model and default thinking fallbacks", () => {
        render(
            <ChatHeader
                selectedSession={{ ...session, model: "", thinkingLevel: undefined }}
                selectedSessionKey="agent:main:main"
                sessionOptions={[{ label: "Main", value: "agent:main:main" }]}
                agentOptions={[]}
                showThinking
                showTools
                liveToolOutput={false}
                onToggleThinking={vi.fn()}
                onToggleTools={vi.fn()}
                onToggleLiveToolOutput={vi.fn()}
                onSelectSession={vi.fn()}
            />
        );

        expect(screen.getByText(/Unknown/u)).toBeInTheDocument();
        expect(screen.getByText(/Thinking: default/u)).toBeInTheDocument();
        expect(screen.getByText(/Verbose: off/u)).toBeInTheDocument();
    });
});
