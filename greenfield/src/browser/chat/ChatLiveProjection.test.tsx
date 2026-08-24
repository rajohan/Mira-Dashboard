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
    test("keeps compaction as one stable lifecycle row and refreshes retry age", () => {
        const store = createChatRuntimeStore();
        const projection = (
            text: "Compacting context" | "Context compacted",
            occurredAtMs: number
        ) =>
            projectChatExternalRun({
                continuity: "complete",
                hasUnprojectedActivity: false,
                observationEpoch: occurredAtMs,
                observedAtMs: occurredAtMs,
                parts: [
                    {
                        id: "compaction:live-compaction",
                        kind: "item",
                        occurredAtMs,
                        sequence: 1,
                        text,
                        type: "compaction",
                    },
                ],
                projectionTruncated: false,
                providerRunId: "live-compaction",
                sessionKey,
                source: "provider-runtime",
                text: "",
                updatedAtMs: occurredAtMs,
            });

        store.installExternalRuns(sessionKey, [projection("Compacting context", 1000)]);
        store.installExternalRuns(sessionKey, [projection("Compacting context", 2000)]);
        let messages = chatRuntimeMessages(store.state, sessionKey);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            parts: [
                {
                    activity: "running",
                    kind: "control",
                    text: "Compacting context",
                },
            ],
            timestampMs: 2000,
        });

        store.installExternalRuns(sessionKey, [projection("Context compacted", 3000)]);
        messages = chatRuntimeMessages(store.state, sessionKey);
        expect(messages).toHaveLength(1);
        expect(messages[0]).toMatchObject({
            parts: [
                {
                    activity: "complete",
                    kind: "control",
                    text: "Context compacted",
                },
            ],
            timestampMs: 3000,
        });
        expect(messages[0]?.id).toBe(
            "external:agent:main:main:live-compaction:segment:compaction:compaction:live-compaction"
        );
    });

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
        const messages = chatRuntimeMessages(store.state, sessionKey);

        expect(
            messages.flatMap((message) => message.parts.map(({ kind }) => kind))
        ).toEqual(["thinking", "thinking", "tool", "thinking", "text", "tool", "text"]);
        expect(
            messages
                .flatMap((message) => message.parts)
                .filter(({ kind }) => kind === "tool")
        ).toEqual([
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
            <div>
                {messages.map((message) => (
                    <ChatMessageBubble
                        display={display}
                        key={message.id}
                        message={message}
                    />
                ))}
            </div>
        );
        expect(screen.getAllByRole("article")).toHaveLength(7);
        const tools = screen.getAllByRole("region", { name: "Bash, completed" });
        expect(tools).toHaveLength(2);
        for (const tool of tools) {
            expect(within(tool).getAllByText("Description")).toHaveLength(1);
            expect(within(tool).getAllByText("Tool input")).toHaveLength(1);
            expect(within(tool).getAllByText("Tool output")).toHaveLength(1);
        }
        expect(within(tools[0]!).getAllByText("pwd (workspace)")).toHaveLength(2);
        expect(within(tools[0]!).getByText("/workspace")).toBeVisible();
        expect(within(tools[1]!).getAllByText("bun test (workspace)")).toHaveLength(2);
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
                message={projection.message}
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

    test("renders an aggregate assistant replacement at the replaced provider position", () => {
        const projection = projectChatExternalRun({
            continuity: "complete",
            hasUnprojectedActivity: false,
            observationEpoch: 1,
            observedAtMs: 1000,
            parts: [
                {
                    kind: "thinking",
                    segmentId: "reasoning-before",
                    sequence: 1,
                    text: "Reasoning before.",
                },
                {
                    kind: "assistant",
                    segmentId: "assistant-replaced",
                    sequence: 2,
                    text: "Stale answer.",
                },
                {
                    callId: "command-after",
                    isError: false,
                    kind: "tool",
                    name: "lookup",
                    phase: "succeeded",
                    sequence: 3,
                },
                {
                    kind: "thinking",
                    segmentId: "reasoning-after",
                    sequence: 4,
                    text: "Reasoning after.",
                },
            ],
            projectionTruncated: false,
            providerRunId: "aggregate-order-run",
            sessionKey,
            source: "provider-runtime",
            text: "Authoritative answer.",
            updatedAtMs: 1000,
        });
        expect(
            projection.segments?.find(
                ({ segmentId }) => segmentId === "aggregate:assistant"
            )?.providerSequence
        ).toBe(2);
        const store = createChatRuntimeStore();
        store.installExternalRuns(sessionKey, [projection]);
        const messages = chatRuntimeMessages(store.state, sessionKey);
        render(
            <div>
                {messages.map((message) => (
                    <ChatMessageBubble
                        display={display}
                        key={message.id}
                        message={message}
                    />
                ))}
            </div>
        );

        const visibleText = document.body.textContent ?? "";
        const visibleOrder = [
            "Reasoning before.",
            "Authoritative answer.",
            "Lookup",
            "Reasoning after.",
        ].map((text) => visibleText.indexOf(text));
        expect(visibleOrder.every((index) => index >= 0)).toBeTrue();
        expect(visibleOrder).toEqual(
            [...visibleOrder].toSorted((left, right) => left - right)
        );
    });
});
