import { renderHook } from "@testing-library/react";
import { act, useRef, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Session } from "../../../types/session";
import type { ActiveChatStreams } from "./chatRuntime";
import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import { useChatSlashCommands } from "./useChatSlashCommands";

type ChatRequest = <T = unknown>(
    method: string,
    params?: Record<string, unknown>
) => Promise<T>;

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        displayLabel: "Main chat",
        elevatedLevel: "off",
        fastMode: false,
        key: "session-a",
        model: "codex",
        reasoningLevel: "off",
        status: "idle",
        thinkingLevel: "medium",
        type: "direct",
        verboseLevel: "off",
        ...overrides,
    } as Session;
}

function makeAttachment(): ChatSendAttachment {
    return {
        contentBase64: "aGVsbG8=",
        file: new File(["hello"], "note.txt", { type: "text/plain" }),
        fileName: "note.txt",
        id: "file-1",
        kind: "text",
        mimeType: "text/plain",
        sizeBytes: 5,
    };
}

function renderSlashCommands(
    overrides: {
        attachments?: ChatSendAttachment[];
        request?: ReturnType<typeof vi.fn>;
        selectedSession?: Session | null;
        selectedSessionKey?: string;
    } = {}
) {
    const request = overrides.request || vi.fn().mockResolvedValue({});

    const hook = renderHook(() => {
        const [messages, setMessages] = useState<ChatHistoryMessage[]>([
            { content: "hello", role: "user", text: "hello" },
        ]);
        const [draft, setDraft] = useState("/help");
        const [sendError, setSendError] = useState<string | null>(null);
        const [isSending, setIsSending] = useState(false);
        const [isAtBottom, setIsAtBottom] = useState(false);
        const [historyLoadVersion, setHistoryLoadVersion] = useState(0);
        const [activeStreams, setActiveStreams] = useState<ActiveChatStreams>({
            "session-a": {
                aliases: ["run-1"],
                runId: "run-1",
                sessionKey: "session-a",
                statusText: "Thinking",
                text: "streaming",
                updatedAt: "2026-05-11T00:00:00.000Z",
            },
        });
        const shouldStickToBottomReference = useRef(false);
        const runCommand = useChatSlashCommands({
            attachments: overrides.attachments || [],
            chatModelOptions: [
                { id: "codex", label: "Codex" },
                { id: "kimi", label: "Kimi" },
            ],
            request: request as unknown as ChatRequest,
            selectedSession: overrides.selectedSession ?? makeSession(),
            selectedSessionKey: overrides.selectedSessionKey ?? "session-a",
            setDraft,
            setHistoryLoadVersion,
            setIsAtBottom,
            setIsSending,
            setMessages,
            setSendError,
            shouldStickToBottomReference,
            showThinkingOutput: false,
            showToolOutput: false,
            updateActiveStreams: setActiveStreams,
        });

        return {
            activeStreams,
            draft,
            historyLoadVersion,
            isAtBottom,
            isSending,
            messages,
            runCommand,
            sendError,
            shouldStickToBottom: shouldStickToBottomReference.current,
        };
    });

    return { request, ...hook };
}

describe("useChatSlashCommands", () => {
    beforeEach(() => {
        vi.stubGlobal("confirm", vi.fn());
    });

    it("ignores non-slash text and blocks slash commands with attachments", async () => {
        const { result } = renderSlashCommands({ attachments: [makeAttachment()] });

        await act(async () => {
            await expect(result.current.runCommand("hello")).resolves.toBe(false);
            await expect(result.current.runCommand("/help")).resolves.toBe(true);
        });

        expect(result.current.sendError).toBe(
            "Slash commands cannot include attachments yet."
        );
        expect(result.current.messages).toHaveLength(1);
    });

    it("renders local help, status, and model list messages", async () => {
        const { result } = renderSlashCommands();

        await act(async () => {
            await result.current.runCommand("/help");
            await result.current.runCommand("/status");
            await result.current.runCommand("/models");
        });

        const systemText = result.current.messages
            .map((message) => message.text)
            .join("\n");
        expect(systemText).toContain("Available slash commands:");
        expect(systemText).toContain("Session: Main chat");
        expect(systemText).toContain("Configured models:\n- codex\n- kimi");
        expect(result.current.draft).toBe("");
        expect(result.current.sendError).toBeNull();
    });

    it("patches session settings for model and runtime commands", async () => {
        const { request, result } = renderSlashCommands();

        await act(async () => {
            await result.current.runCommand("/model kimi");
            await result.current.runCommand("/fast on");
            await result.current.runCommand("/reasoning summary");
            await result.current.runCommand("/think high");
            await result.current.runCommand("/verbose detailed");
            await result.current.runCommand("/elevated ask");
            await result.current.runCommand("/usage full");
            await result.current.runCommand("/exec host allowlist always node-a");
        });

        expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "session-a",
            model: "kimi",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            fastMode: true,
            key: "session-a",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "session-a",
            reasoningLevel: "summary",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "session-a",
            thinkingLevel: "high",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "session-a",
            verboseLevel: "detailed",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            elevatedLevel: "ask",
            key: "session-a",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            key: "session-a",
            responseUsage: "full",
        });
        expect(request).toHaveBeenCalledWith("sessions.patch", {
            execAsk: "always",
            execHost: "host",
            execNode: "node-a",
            execSecurity: "allowlist",
            key: "session-a",
        });
        expect(result.current.isSending).toBe(false);
        expect(result.current.messages.at(-1)?.text).toBe("Exec defaults updated.");
    });

    it("reports current runtime settings without patching", async () => {
        const { request, result } = renderSlashCommands({
            selectedSession: makeSession({ fastMode: true }),
        });

        await act(async () => {
            await result.current.runCommand("/model");
            await result.current.runCommand("/think");
            await result.current.runCommand("/verbose");
            await result.current.runCommand("/fast status");
            await result.current.runCommand("/reasoning");
            await result.current.runCommand("/elevated");
            await result.current.runCommand("/usage");
        });

        expect(request).not.toHaveBeenCalled();
        const systemText = result.current.messages
            .map((message) => message.text)
            .join("\n");
        expect(systemText).toContain("Current model: codex");
        expect(systemText).toContain("Current thinking level: medium");
        expect(systemText).toContain("Current verbose mode: off");
        expect(systemText).toContain("Current fast mode: on");
        expect(systemText).toContain("Current reasoning visibility: off");
        expect(systemText).toContain("Current elevated mode: off");
        expect(systemText).toContain("Session usage:");
    });

    it("clears local chat view and stops active runs", async () => {
        const { request, result } = renderSlashCommands();

        await act(async () => {
            await result.current.runCommand("/clear");
        });

        expect(result.current.messages.map((message) => message.text)).toEqual([
            "Local chat view cleared. Session history was not reset.",
        ]);
        expect(result.current.activeStreams["session-a"]).toBeUndefined();

        await act(async () => {
            await result.current.runCommand("/stop");
        });

        expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "session-a" });
        expect(result.current.messages.at(-1)?.text).toBe("Stopped current run.");
    });

    it("cancels or confirms reset and reloads history", async () => {
        const request = vi.fn().mockImplementation(async (method: string) => {
            if (method === "chat.history") {
                return {
                    messages: [
                        {
                            content: "reloaded",
                            role: "assistant",
                            text: "reloaded",
                        },
                    ],
                };
            }

            return {};
        });
        const { result } = renderSlashCommands({ request });

        (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(false);
        await act(async () => {
            await result.current.runCommand("/reset");
        });
        expect(result.current.messages.at(-1)?.text).toBe("Reset cancelled.");
        expect(request).not.toHaveBeenCalledWith("sessions.reset", expect.anything());

        (window.confirm as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);
        await act(async () => {
            await result.current.runCommand("/new");
        });

        expect(request).toHaveBeenCalledWith("sessions.reset", { key: "session-a" });
        expect(request).toHaveBeenCalledWith("chat.history", {
            limit: 1000,
            sessionKey: "session-a",
        });
        expect(result.current.messages.map((message) => message.text)).toContain(
            "Session reset."
        );
        expect(result.current.historyLoadVersion).toBe(1);
        expect(result.current.isAtBottom).toBe(true);
        expect(result.current.shouldStickToBottom).toBe(true);
    });

    it("tracks compact progress and reports failures", async () => {
        const request = vi
            .fn()
            .mockResolvedValueOnce({ compacted: false, reason: "too small" })
            .mockRejectedValueOnce(new Error("compact failed"));
        const { result } = renderSlashCommands({ request });

        await act(async () => {
            await result.current.runCommand("/compact");
        });

        expect(request).toHaveBeenCalledWith("sessions.compact", { key: "session-a" });
        expect(result.current.messages.at(-1)?.text).toBe(
            "Compaction skipped: too small"
        );
        expect(result.current.activeStreams["session-a"]).toBeUndefined();

        await act(async () => {
            await result.current.runCommand("/compact");
        });
        expect(result.current.sendError).toBe("compact failed");
        expect(result.current.isSending).toBe(false);
    });
});
