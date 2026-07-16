import { describe, expect, it } from "bun:test";

import type { ChatHistoryMessage } from "../components/features/chat/chatTypes";
import {
    createChatVisibility,
    presentChatMessages,
} from "../components/features/chat/domain/chatPresentation";
import {
    projectChat,
    reconcileChatMessages,
} from "../components/features/chat/domain/chatProjection";
import {
    addOptimisticChatRun,
    type ChatRuntimeEvent,
    createChatRuntimeState,
    reduceChatRuntime,
} from "../components/features/chat/domain/chatState";

const SESSION = "agent:main:main";
const NOW = "2026-07-16T12:00:00.000Z";
type EventDraft = ChatRuntimeEvent extends infer Event
    ? Event extends ChatRuntimeEvent
        ? Omit<Event, "sequence" | "sessionKey" | "timestamp">
        : never
    : never;

function event(sequence: number, draft: EventDraft): ChatRuntimeEvent {
    return {
        ...draft,
        sequence,
        sessionKey: SESSION,
        timestamp: NOW,
    } as ChatRuntimeEvent;
}

function message(role: string, text: string, runId?: string): ChatHistoryMessage {
    return { content: text, role, runId, text };
}

describe("chat projection", () => {
    it("matches a recovered final only inside the latest user turn", () => {
        const history = [
            message("user", "first"),
            message("assistant", "OK"),
            message("user", "second"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "finish",
                message: message("assistant", "OK", "run-2"),
                outcome: "completed",
                runId: "run-2",
            }),
        ]);

        expect(
            reconcileChatMessages(history, runtime.sessions[SESSION]).map(
                (item) => item.text
            )
        ).toEqual(["first", "OK", "second", "OK"]);
    });

    it("keeps identical answers from distinct overlapping runs", () => {
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "assistant",
                message: message("assistant", "same", "run-1"),
                mode: "merge",
                runId: "run-1",
                source: "chat",
            }),
            event(32, {
                kind: "assistant",
                message: message("assistant", "same", "run-2"),
                mode: "merge",
                runId: "run-2",
                source: "chat",
            }),
            event(48, {
                kind: "finish",
                message: message("assistant", "same", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
            event(64, {
                kind: "finish",
                message: message("assistant", "same", "run-2"),
                outcome: "completed",
                runId: "run-2",
            }),
        ]);

        const reconciled = reconcileChatMessages(
            [message("user", "parallel")],
            runtime.sessions[SESSION]
        );
        expect(reconciled.map((item) => [item.text, item.runId])).toEqual([
            ["parallel", undefined],
            ["same", "run-1"],
            ["same", "run-2"],
        ]);
    });

    it("inserts unrecovered diagnostics immediately before a canonical final", () => {
        const history = [
            message("user", "question"),
            message("assistant", "answer", "run-1"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "reasoning" }],
                },
                runId: "run-1",
            }),
            event(32, {
                kind: "tool",
                message: {
                    content: "",
                    role: "assistant",
                    text: "",
                    toolCalls: [{ id: "call-1", name: "read" }],
                },
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            event(48, {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);

        expect(reconciled).toHaveLength(4);
        expect(reconciled[1]?.toolCalls?.[0]?.id).toBe("call-1");
        expect(reconciled[2]?.thinking?.[0]?.text).toBe("reasoning");
        expect(reconciled[3]?.text).toBe("answer");
    });

    it("places diagnostics before an unscoped history final when finish has no text", () => {
        const history = [message("user", "question"), message("assistant", "answer")];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "thinking",
                message: {
                    content: [{ text: "reasoning", type: "thinking" }],
                    role: "assistant",
                    text: "",
                    thinking: [{ text: "reasoning" }],
                },
                runId: "run-1",
            }),
            event(32, {
                kind: "finish",
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        expect(reconciled.map((item) => item.text)).toEqual(["question", "", "answer"]);
        expect(reconciled[1]?.thinking?.[0]?.text).toBe("reasoning");
    });

    it("does not replay completed tool diagnostics already present in history", () => {
        const toolDiagnostic: ChatHistoryMessage = {
            content: "",
            role: "assistant",
            text: "",
            toolCalls: [
                {
                    arguments: { path: "a" },
                    id: "call-1",
                    name: "read",
                    toolResult: {
                        content: "done",
                        id: "call-1",
                        name: "read",
                    },
                },
            ],
        };
        const history = [
            message("user", "question"),
            toolDiagnostic,
            message("assistant", "answer", "run-1"),
        ];
        const runtime = reduceChatRuntime(createChatRuntimeState(), [
            event(16, {
                kind: "tool",
                message: toolDiagnostic,
                runId: "run-1",
                toolKey: "tool:call-1",
            }),
            event(32, {
                kind: "finish",
                message: message("assistant", "answer", "run-1"),
                outcome: "completed",
                runId: "run-1",
            }),
        ]);

        const reconciled = reconcileChatMessages(history, runtime.sessions[SESSION]);
        expect(
            reconciled.filter((item) => item.toolCalls?.[0]?.id === "call-1")
        ).toHaveLength(1);
    });

    it("keeps hidden tool media inside its originating run and user boundary", () => {
        const toolMedia: ChatHistoryMessage = {
            attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
            content: "",
            role: "tool",
            runId: "run-1",
            text: "",
            toolResult: { content: "", id: "call-1", name: "write" },
        };
        const user = message("user", "next");
        const nextAnswer = message("assistant", "answer", "run-2");

        const visible = presentChatMessages(
            [toolMedia, user, nextAnswer],
            createChatVisibility(true, false)
        );

        expect(visible.map((item) => item.role)).toEqual([
            "assistant",
            "user",
            "assistant",
        ]);
        expect(visible[0]?.runId).toBe("run-1");
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("report.txt");
        expect(visible[2]?.attachments).toEqual(undefined);
    });

    it("merges hidden tool media into the compatible assistant run", () => {
        const visible = presentChatMessages(
            [
                {
                    attachments: [{ fileName: "report.txt", id: "report", kind: "text" }],
                    content: "",
                    role: "tool",
                    runId: "run-1",
                    text: "",
                    toolResult: { content: "", name: "write" },
                },
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, false)
        );

        expect(visible).toHaveLength(1);
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("report.txt");
    });

    it("preserves media folded into a hidden assistant tool diagnostic", () => {
        const visible = presentChatMessages(
            [
                {
                    attachments: [
                        { fileName: "generated.txt", id: "generated", kind: "text" },
                    ],
                    content: "",
                    role: "assistant",
                    runId: "run-1",
                    text: "",
                    toolCalls: [
                        {
                            id: "call-1",
                            name: "write",
                            toolResult: { content: "", id: "call-1", name: "write" },
                        },
                    ],
                },
                message("assistant", "done", "run-1"),
            ],
            createChatVisibility(true, false)
        );

        expect(visible).toHaveLength(1);
        expect(visible[0]?.attachments?.[0]?.fileName).toBe("generated.txt");
    });

    it("treats thinking visibility as a reversible projection", () => {
        const raw = [
            message("user", "question"),
            {
                content: [{ text: "reasoning", type: "thinking" }],
                role: "assistant",
                runId: "run-1",
                text: "",
                thinking: [{ text: "reasoning" }],
            },
            message("assistant", "answer", "run-1"),
        ];

        expect(
            presentChatMessages(raw, createChatVisibility(false, true), true).some(
                (item) => item.thinking?.length
            )
        ).toBe(false);
        expect(
            presentChatMessages(raw, createChatVisibility(true, true), true).some(
                (item) => item.thinking?.[0]?.text === "reasoning"
            )
        ).toBe(true);
        expect(
            presentChatMessages(raw, createChatVisibility(true, true), false).some(
                (item) => item.thinking?.length
            )
        ).toBe(false);
    });

    it("projects a single compacting status without mutating messages", () => {
        const runtime = addOptimisticChatRun(
            createChatRuntimeState(),
            SESSION,
            "dashboard-compact-1",
            "compact"
        );
        const projection = projectChat(
            [],
            runtime,
            SESSION,
            createChatVisibility(false, false),
            false,
            new Set()
        );

        expect(projection.isCompacting).toBe(true);
        expect(projection.rows).toEqual([
            expect.objectContaining({
                kind: "typing",
                message: expect.objectContaining({ text: "Compacting context" }),
            }),
        ]);
    });
});
