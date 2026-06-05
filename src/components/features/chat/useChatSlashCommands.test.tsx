import { renderHook } from "@testing-library/react";
import { act, useState } from "react";
import { describe, expect, it, vi } from "vitest";

import type { ActiveChatStreams } from "./chatRuntime";
import type { ChatHistoryMessage, ChatSendAttachment } from "./chatTypes";
import { SLASH_COMMANDS, slashCommandCanonicalName } from "./slashCommands";
import { useChatSlashCommands } from "./useChatSlashCommands";

type ChatRequest = <T = unknown>(
    method: string,
    params?: Record<string, unknown>
) => Promise<T>;

const LOCALLY_HANDLED_COMMANDS = new Set(["/abort", "/stop"]);

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
        initialIsSending?: boolean;
        initialSendError?: string | null;
        selectedSessionKey?: string;
    } = {}
) {
    const request = overrides.request || vi.fn().mockResolvedValue({});

    const hook = renderHook(() => {
        const [messages, setMessages] = useState<ChatHistoryMessage[]>([
            { content: "hello", role: "user", text: "hello" },
        ]);
        const [draft, setDraft] = useState("/steer keep going");
        const [sendError, setSendError] = useState<string | null>(
            overrides.initialSendError ?? null
        );
        const [isSending, setIsSending] = useState(overrides.initialIsSending ?? false);
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
        const runCommand = useChatSlashCommands({
            attachments: overrides.attachments || [],
            request: request as unknown as ChatRequest,
            selectedSessionKey: overrides.selectedSessionKey ?? "session-a",
            setDraft,
            setIsSending,
            setMessages,
            setSendError,
            updateActiveStreams: setActiveStreams,
        });

        return {
            activeStreams,
            draft,
            isSending,
            messages,
            runCommand,
            sendError,
        };
    });

    return { request, ...hook };
}

describe("useChatSlashCommands", () => {
    it("ignores non-slash text", async () => {
        const { request, result } = renderSlashCommands();

        await act(async () => {
            await expect(result.current.runCommand("hello")).resolves.toBe(false);
        });

        expect(request).not.toHaveBeenCalled();
        expect(result.current.messages).toHaveLength(1);
        expect(result.current.sendError).toBeNull();
    });

    it("passes OpenClaw commands through unless they need a dedicated Dashboard RPC", async () => {
        const { request, result } = renderSlashCommands();
        const passThroughCommands = SLASH_COMMANDS.flatMap((definition) => [
            definition.name,
            ...(definition.aliases || []),
        ]).filter(
            (command) => !LOCALLY_HANDLED_COMMANDS.has(slashCommandCanonicalName(command))
        );

        await act(async () => {
            for (const command of passThroughCommands) {
                await expect(result.current.runCommand(`${command} test`)).resolves.toBe(
                    false
                );
            }
        });

        expect(passThroughCommands).toContain("/help");
        expect(passThroughCommands).toContain("/model");
        expect(passThroughCommands).toContain("/queue");
        expect(passThroughCommands).toContain("/goal");
        expect(passThroughCommands).not.toContain("/clear");
        expect(request).not.toHaveBeenCalled();
        expect(result.current.sendError).toBeNull();
    });

    it("stops the selected session through chat.abort", async () => {
        const { request, result } = renderSlashCommands();

        await act(async () => {
            await result.current.runCommand("/stop");
        });

        expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "session-a" });
        expect(result.current.draft).toBe("");
        expect(result.current.isSending).toBe(false);
        expect(result.current.messages.at(-1)?.text).toBe("Stopped current run.");
        expect(result.current.activeStreams["session-a"]).toBeUndefined();
    });

    it("stops the selected session through the abort alias", async () => {
        const { request, result } = renderSlashCommands();

        await act(async () => {
            await result.current.runCommand("/abort");
        });

        expect(request).toHaveBeenCalledWith("chat.abort", { sessionKey: "session-a" });
        expect(result.current.draft).toBe("");
        expect(result.current.isSending).toBe(false);
        expect(result.current.messages.at(-1)?.text).toBe("Stopped current run.");
        expect(result.current.activeStreams["session-a"]).toBeUndefined();
    });

    it("blocks local control commands with attachments", async () => {
        const { request, result } = renderSlashCommands({
            attachments: [makeAttachment()],
        });

        await act(async () => {
            await expect(result.current.runCommand("/stop")).resolves.toBe(true);
        });

        expect(request).not.toHaveBeenCalled();
        expect(result.current.draft).toBe("/steer keep going");
        expect(result.current.sendError).toBe("/stop cannot include attachments.");
    });
});
