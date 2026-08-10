import { describe, expect, test } from "bun:test";

import { projectChatExternalRun } from "./chatContractAdapter.ts";
import { ChatMessageBubble } from "./ChatMessageBubble.tsx";
import { chatRuntimeMessages, createChatRuntimeStore } from "./chatRuntimeStore.ts";

const { render, screen, within } = await import("@testing-library/react");

const sessionKey = "agent:main:main";
const display = {
    keepThinkingAfterFinal: false,
    showThinking: true,
    showTools: true,
    toolsExpanded: true,
};

describe("live OpenClaw chat projection", () => {
    test("renders exact provider order and complete session.tool bubbles without raw items", () => {
        const projection = projectChatExternalRun({
            continuity: "complete",
            hasUnprojectedActivity: false,
            observationEpoch: 1,
            observedAtMs: 1000,
            parts: [
                {
                    kind: "thinking",
                    segmentId: "live-run:reasoning-1",
                    sequence: 1,
                    streamId: "agent:reasoning",
                    text: "Reasoning one.",
                },
                {
                    kind: "thinking",
                    segmentId: "agent:preamble:preamble-1",
                    sequence: 2,
                    streamId: "agent:preamble",
                    text: "Preparing the first command.",
                },
                {
                    id: "raw-analysis",
                    kind: "item",
                    sequence: 3,
                    text: "raw-analysis-label",
                    type: "analysis",
                },
                {
                    callId: "command-1",
                    input: '{"cmd":"pwd","workdir":"/workspace"}',
                    isError: false,
                    kind: "tool",
                    name: "functions.exec_command",
                    phase: "started",
                    sequence: 4,
                },
                {
                    id: "raw-command",
                    kind: "item",
                    sequence: 5,
                    text: "raw-command-label",
                    type: "command",
                },
                {
                    callId: "command-1",
                    isError: false,
                    kind: "tool",
                    name: "functions.exec_command",
                    output: "/workspace",
                    phase: "succeeded",
                    sequence: 6,
                },
                {
                    kind: "thinking",
                    segmentId: "live-run:reasoning-2",
                    sequence: 7,
                    streamId: "agent:reasoning",
                    text: "Reasoning two.",
                },
                {
                    kind: "assistant",
                    segmentId: "live-run:assistant-1",
                    sequence: 8,
                    streamId: "assistant",
                    text: "Before the second tool.",
                },
                {
                    id: "raw-tool",
                    kind: "item",
                    sequence: 9,
                    text: "raw-tool-label",
                    type: "tool",
                },
                {
                    callId: "command-2",
                    input: '{"cmd":"bun test","workdir":"/workspace"}',
                    isError: false,
                    kind: "tool",
                    name: "functions.exec_command",
                    phase: "started",
                    sequence: 10,
                },
                {
                    callId: "command-2",
                    isError: false,
                    kind: "tool",
                    name: "functions.exec_command",
                    output: "12 pass\n0 fail",
                    phase: "succeeded",
                    sequence: 11,
                },
                {
                    kind: "assistant",
                    segmentId: "live-run:assistant-2",
                    sequence: 12,
                    streamId: "assistant",
                    text: "After the second tool.",
                },
            ],
            projectionTruncated: false,
            providerRunId: "live-run",
            sessionKey,
            source: "provider-runtime",
            text: "Before the second tool.After the second tool.",
            updatedAtMs: 1000,
        });
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [projection]);
        const message = chatRuntimeMessages(store.state, sessionKey)[0]!;

        expect(message.parts.map(({ kind }) => kind)).toEqual([
            "thinking",
            "thinking",
            "tool",
            "thinking",
            "text",
            "tool",
            "text",
        ]);
        expect(message.parts.filter(({ kind }) => kind === "tool")).toEqual([
            expect.objectContaining({
                callId: "command-1",
                input: '{"cmd":"pwd","workdir":"/workspace"}',
                output: "/workspace",
                status: "completed",
            }),
            expect.objectContaining({
                callId: "command-2",
                input: '{"cmd":"bun test","workdir":"/workspace"}',
                output: "12 pass\n0 fail",
                status: "completed",
            }),
        ]);

        const rendered = render(
            <ChatMessageBubble display={display} message={message} />
        );
        const tools = screen.getAllByRole("region", { name: "Bash, completed" });
        expect(tools).toHaveLength(2);
        for (const tool of tools) {
            expect(within(tool).getAllByText("Description")).toHaveLength(1);
            expect(within(tool).getAllByText("Tool input")).toHaveLength(1);
            expect(within(tool).getAllByText("Tool output")).toHaveLength(1);
        }
        expect(within(tools[0]!).getByText("pwd (workspace)")).toBeVisible();
        expect(within(tools[0]!).getByText("/workspace")).toBeVisible();
        expect(within(tools[1]!).getByText("bun test (workspace)")).toBeVisible();
        expect(within(tools[1]!).getByText(/12 pass/iu)).toBeVisible();
        expect(screen.queryByText(/raw-(?:analysis|command|tool)-label/iu)).toBeNull();
        const visibleText = document.body.textContent ?? "";
        const visibleOrder = [
            "Reasoning one.",
            "Preparing the first command.",
            "pwd (workspace)",
            "Reasoning two.",
            "Before the second tool.",
            "bun test (workspace)",
            "After the second tool.",
        ].map((text) => visibleText.indexOf(text));
        expect(visibleOrder.every((index) => index >= 0)).toBeTrue();
        expect(visibleOrder).toEqual(
            [...visibleOrder].toSorted((left, right) => left - right)
        );
        rendered.unmount();

        const mixedWithoutTools = render(
            <ChatMessageBubble
                display={{ ...display, showTools: false }}
                message={message}
            />
        );
        expect(screen.getByRole("article")).toBeVisible();
        expect(screen.getByText("Reasoning one.")).toBeVisible();
        expect(screen.getByText("Before the second tool.")).toBeVisible();
        expect(screen.queryByRole("region", { name: "Bash, completed" })).toBeNull();
        mixedWithoutTools.unmount();

        const toolOnly = projectChatExternalRun({
            continuity: "complete",
            hasUnprojectedActivity: false,
            observationEpoch: 1,
            observedAtMs: 1001,
            parts: [
                {
                    callId: "tool-only",
                    isError: false,
                    kind: "tool",
                    name: "lookup",
                    output: "done",
                    phase: "succeeded",
                    sequence: 1,
                },
            ],
            projectionTruncated: false,
            providerRunId: "tool-only-run",
            sessionKey,
            source: "provider-runtime",
            text: "",
            updatedAtMs: 1001,
        }).message;
        render(
            <ChatMessageBubble
                display={{ ...display, showTools: false }}
                message={toolOnly}
            />
        );
        expect(screen.queryByRole("article")).toBeNull();
    });
});
