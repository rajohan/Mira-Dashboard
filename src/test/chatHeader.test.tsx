import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "bun:test";

import { ChatHeader } from "../components/features/chat/ChatHeader";
import type { Session } from "../types/session";

afterEach(() => {
    jest.useRealTimers();
});

function session(updatedAt: number): Session {
    return {
        agentType: "codex",
        channel: "web",
        createdAt: "2026-07-22T12:00:00.000Z",
        displayLabel: "Main",
        displayName: "Main",
        effectiveFastMode: "auto",
        hookName: "",
        id: "session-1",
        key: "agent:main:main",
        kind: "agent",
        label: "Main",
        maxTokens: 1000,
        model: "gpt-5.6-sol",
        tokenCount: 500,
        thinkingDefault: "low",
        thinkingLevel: "medium",
        type: "agent",
        updatedAt,
    };
}

/** Creates the wire shape OpenClaw can send before timestamp normalization. */
function sessionWithWireTimestamp(updatedAt: string): Session {
    return {
        ...session(Date.parse(updatedAt)),
        updatedAt,
    } as unknown as Session;
}

describe("ChatHeader", () => {
    it("refreshes the relative session update time while metadata stays unchanged", () => {
        jest.useFakeTimers();
        const updatedAt = Date.now();

        render(
            <ChatHeader
                selectedSession={session(updatedAt)}
                selectedAgentId="main"
                selectedSessionKey="agent:main:main"
                agentOptions={[]}
                sessionOptions={[{ label: "Main session", value: "agent:main:main" }]}
                onSelectAgent={jest.fn()}
                onSelectSession={jest.fn()}
            />
        );

        expect(screen.getByText(/less than 5 seconds ago/u)).toBeInTheDocument();
        expect(screen.getByText("Model: gpt-5.6-sol")).toBeInTheDocument();
        expect(screen.getByText("Thinking: medium")).toBeInTheDocument();
        expect(screen.getByText("Speed: Default (Auto)")).toBeInTheDocument();
        expect(screen.queryByText(/MAIN/u)).not.toBeInTheDocument();
        expect(screen.queryByText(/gpt-5\.6-sol · Context:/u)).not.toBeInTheDocument();

        act(() => {
            jest.advanceTimersByTime(10_000);
        });

        expect(screen.getByText(/less than 20 seconds ago/u)).toBeInTheDocument();
    });

    it("preserves ISO session timestamps while refreshing their relative age", () => {
        jest.useFakeTimers();
        const updatedAt = new Date(Date.now()).toISOString();

        render(
            <ChatHeader
                selectedSession={sessionWithWireTimestamp(updatedAt)}
                selectedAgentId="main"
                selectedSessionKey="agent:main:main"
                agentOptions={[]}
                sessionOptions={[{ label: "Main session", value: "agent:main:main" }]}
                onSelectAgent={jest.fn()}
                onSelectSession={jest.fn()}
            />
        );

        expect(screen.getByText(/less than 5 seconds ago/u)).toBeInTheDocument();

        act(() => {
            jest.advanceTimersByTime(10_000);
        });

        expect(screen.getByText(/less than 20 seconds ago/u)).toBeInTheDocument();
    });
});
