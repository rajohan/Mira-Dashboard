import { describe, expect, jest, test } from "bun:test";

import { safeChatMarkdownLink } from "./chatMarkdownPolicy.ts";
import { ChatMessageBubble } from "./ChatMessageBubble.tsx";

const { render, screen, waitFor, within } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const display = {
    keepThinkingAfterFinal: false,
    showThinking: true,
    showTools: true,
    toolsExpanded: false,
};

describe("chat message bubble", () => {
    test("presents provider-neutral send admission without claiming queued state", () => {
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    delivery: "accepted",
                    id: "message-accepted",
                    parts: [{ kind: "text", text: "Follow provider steering" }],
                    role: "user",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        expect(screen.getByText(/accepted/iu)).toBeVisible();
        expect(screen.queryByText(/queued/iu)).toBeNull();
    });

    test("blocks provider Markdown resource leaks and unsafe link schemes", () => {
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-1",
                    parts: [
                        {
                            kind: "text",
                            text: [
                                "![tracking](https://tracker.example/pixel.png)",
                                "[script](javascript:alert(1))",
                                "[payload](data:text/html,bad)",
                                "[offsite](//evil.example/path)",
                                "[local](/reports)",
                                "[section](#evidence)",
                                "[mail](mailto:operator@example.com)",
                            ].join(" "),
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        expect(screen.queryByRole("img")).toBeNull();
        expect(screen.getByRole("note")).toHaveTextContent(
            "External image blocked: tracking"
        );
        expect(screen.queryByRole("link", { name: "script" })).toBeNull();
        expect(screen.queryByRole("link", { name: "payload" })).toBeNull();
        expect(screen.getByRole("link", { name: "offsite" })).toHaveAttribute(
            "href",
            "https://evil.example/path"
        );
        expect(screen.getByRole("link", { name: "offsite" })).toHaveAttribute(
            "rel",
            "noopener noreferrer"
        );
        expect(screen.getByRole("link", { name: "offsite" })).toHaveAttribute(
            "target",
            "_blank"
        );
        expect(screen.getByRole("link", { name: "local" })).not.toHaveAttribute("target");
        expect(screen.getByRole("link", { name: "section" })).toHaveAttribute(
            "href",
            "#evidence"
        );
        expect(screen.getByRole("link", { name: "mail" })).not.toHaveAttribute("target");
    });

    test("classifies links after URL parsing, including protocol-relative URLs", () => {
        expect(safeChatMarkdownLink("javascript:alert(1)")).toBeUndefined();
        expect(safeChatMarkdownLink("data:text/plain,bad")).toBeUndefined();
        const protocolRelative = safeChatMarkdownLink("//evil.example/path");
        expect(protocolRelative).toMatchObject({ external: true });
        expect(new URL(protocolRelative!.href).hostname).toBe("evil.example");
        expect(safeChatMarkdownLink("/reports")).toMatchObject({ external: false });
        expect(safeChatMarkdownLink("#part")).toEqual({
            external: false,
            href: "#part",
        });
        expect(safeChatMarkdownLink("mailto:mira@example.com")).toMatchObject({
            external: false,
        });
    });

    test("exposes tool lifecycle through an expandable accessible region", async () => {
        const user = userEvent.setup();
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-tool",
                    parts: [
                        {
                            callId: "call-1",
                            error: "Unavailable",
                            kind: "tool",
                            name: "status",
                            output: "Unavailable",
                            status: "failed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );
        const toggle = screen.getByRole("button", { name: /status failed/iu });
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(screen.getAllByText("Unavailable")).toHaveLength(1);
        expect(
            screen.getByRole("region", { name: "Status tool output" })
        ).toHaveAttribute("tabindex", "0");
        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "false");
    });

    test("groups tool description, input, and output in one completed bubble", async () => {
        const user = userEvent.setup();
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-complete-tool",
                    parts: [
                        {
                            callId: "call-1",
                            input: {
                                cmd: "bun test",
                                workdir: "/workspace/mira-dashboard",
                            },
                            kind: "tool",
                            name: "functions.exec_command",
                            output: "8 pass\n0 fail",
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const tool = screen.getByRole("region", {
            name: "Bash, completed",
        });
        const toggle = screen.getByRole("button", { name: /Bash completed/iu });
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(within(tool).queryByText("Tool output")).toBeNull();
        await user.click(toggle);
        expect(within(tool).getByText("Description")).toBeVisible();
        expect(within(tool).getByText("bun test (mira-dashboard)")).toBeVisible();
        expect(within(tool).getByText("Tool input")).toBeVisible();
        expect(within(tool).getByText("Tool output")).toBeVisible();
        expect(within(tool).getByText(/8 pass/iu)).toBeVisible();
        expect(
            within(tool).getByRole("region", { name: "Bash tool input" })
        ).toHaveAttribute("tabindex", "0");
        expect(
            within(tool).getByRole("region", { name: "Bash tool output" })
        ).toHaveAttribute("tabindex", "0");
        expect(within(tool).queryByText("running")).toBeNull();
    });

    test("removes a tool-only message when tool visibility is disabled", () => {
        render(
            <ChatMessageBubble
                display={{ ...display, showTools: false }}
                message={{
                    attachments: [],
                    id: "hidden-tool-message",
                    parts: [
                        {
                            callId: "call-1",
                            kind: "tool",
                            name: "lookup",
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        expect(screen.queryByRole("article")).toBeNull();
        expect(screen.queryByText("No visible message content.")).toBeNull();
    });

    test("local hide invokes only the browser-owned callback", async () => {
        const user = userEvent.setup();
        let hidden = "";
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-local",
                    parts: [{ kind: "text", text: "Keep provider history" }],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
                onHide={(messageId) => {
                    hidden = messageId;
                }}
            />
        );
        await user.click(
            screen.getByRole("button", { name: "Hide message from this browser" })
        );
        expect(hidden).toBe("");
        expect(
            screen.getByRole("heading", { name: "Hide this message locally?" })
        ).toBeVisible();
        await user.click(screen.getByRole("button", { name: "Hide message" }));
        expect(hidden).toBe("message-local");
    });

    test("previews only attachments explicitly approved as inline raster images", () => {
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [
                        {
                            downloadUrl:
                                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=download",
                            id: "raster",
                            mediaType: "image/png",
                            name: "photo.png",
                            previewUrl:
                                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=preview",
                            renderPolicy: "inline-image",
                            sizeBytes: 12,
                        },
                        {
                            downloadUrl:
                                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb41?disposition=download",
                            id: "vector",
                            mediaType: "image/svg+xml",
                            name: "vector.svg",
                            renderPolicy: "download-only",
                            sizeBytes: 13,
                        },
                        {
                            downloadUrl:
                                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb42?disposition=download",
                            id: "document",
                            mediaType: "text/html",
                            name: "document.html",
                            renderPolicy: "download-only",
                            sizeBytes: 14,
                        },
                    ],
                    id: "message-attachments",
                    parts: [],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        expect(screen.getAllByRole("img")).toHaveLength(1);
        expect(screen.getByRole("img", { name: "photo.png" })).toHaveAttribute(
            "src",
            "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb40?disposition=preview"
        );
        expect(screen.getByRole("link", { name: "vector.svg" })).toHaveAttribute(
            "href",
            "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb41?disposition=download"
        );
        expect(screen.getByRole("link", { name: "document.html" })).toHaveAttribute(
            "href",
            "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb42?disposition=download"
        );
    });

    test("uses distinct solid outer and nested assistant surfaces without bubble chrome", () => {
        render(
            <ChatMessageBubble
                display={{ ...display, keepThinkingAfterFinal: true }}
                message={{
                    attachments: [],
                    id: "surface-message",
                    parts: [
                        {
                            kind: "thinking",
                            status: "complete",
                            text: "Private working surface",
                        },
                        { kind: "text", text: "Final answer surface" },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );
        const surface = screen.getByTestId("chat-message-surface-assistant");
        expect(surface).toHaveClass("bg-primary-950");
        expect(surface.className).not.toMatch(/(?:border|shadow)/u);
        expect(screen.getByText("Private working surface").parentElement).toHaveClass(
            "bg-primary-800"
        );
    });

    test("reads only finished assistant final text and exposes playing stop state", async () => {
        const onReadAloud = jest.fn();
        const onStopReadAloud = jest.fn();
        const user = userEvent.setup();
        const message = {
            attachments: [],
            id: "read-message",
            parts: [
                {
                    kind: "thinking" as const,
                    status: "complete" as const,
                    text: "Do not narrate this",
                },
                {
                    callId: "tool-complete",
                    kind: "tool" as const,
                    name: "status",
                    output: "Do not narrate tool output",
                    status: "completed" as const,
                },
                { kind: "text" as const, text: "Narrate only this final answer." },
            ],
            role: "assistant" as const,
            sequence: 1,
            sessionKey: "agent:main:main",
        };
        const rendered = render(
            <ChatMessageBubble
                display={display}
                message={message}
                onReadAloud={onReadAloud}
                onStopReadAloud={onStopReadAloud}
                readAloud={{ phase: "idle" }}
            />
        );
        await user.click(screen.getByRole("button", { name: "Read Mira message aloud" }));
        expect(onReadAloud).toHaveBeenCalledWith(
            "read-message",
            "Narrate only this final answer."
        );

        rendered.rerender(
            <ChatMessageBubble
                display={display}
                message={message}
                onReadAloud={onReadAloud}
                onStopReadAloud={onStopReadAloud}
                readAloud={{
                    activeMessageId: "read-message",
                    phase: "playing",
                }}
            />
        );
        const stop = screen.getByRole("button", { name: "Stop reading aloud" });
        expect(stop).toHaveAttribute("aria-pressed", "true");
        await user.click(stop);
        expect(onStopReadAloud).toHaveBeenCalledTimes(1);
    });

    test("does not offer read aloud for text-only streaming runs", () => {
        render(
            <ChatMessageBubble
                activeRunIds={["run-active"]}
                display={display}
                message={{
                    attachments: [],
                    id: "streaming-text",
                    parts: [{ kind: "text", text: "Partial streamed answer" }],
                    role: "assistant",
                    runId: "run-active",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
                onReadAloud={jest.fn()}
                onStopReadAloud={jest.fn()}
                readAloud={{ phase: "idle" }}
            />
        );
        expect(
            screen.queryByRole("button", { name: "Read Mira message aloud" })
        ).toBeNull();
    });

    test("fetches only sanctioned bounded historical text previews", async () => {
        const originalFetch = globalThis.fetch;
        const fetchMock = jest.fn((_input: RequestInfo | URL) =>
            Promise.resolve(
                new Response("Bounded historical text", {
                    headers: { "content-type": "text/plain" },
                })
            )
        );
        globalThis.fetch = fetchMock;
        const user = userEvent.setup();
        try {
            render(
                <ChatMessageBubble
                    display={display}
                    message={{
                        attachments: [
                            {
                                downloadUrl:
                                    "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb43?disposition=download",
                                id: "text-preview",
                                mediaType: "text/plain",
                                name: "notes.txt",
                                previewUrl:
                                    "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb43?disposition=preview",
                                renderPolicy: "bounded-text",
                                sizeBytes: 23,
                            },
                        ],
                        id: "message-text-attachment",
                        parts: [],
                        role: "assistant",
                        sequence: 1,
                        sessionKey: "agent:main:main",
                    }}
                />
            );
            expect(screen.getByRole("link", { name: "notes.txt" })).toHaveAttribute(
                "href",
                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb43?disposition=download"
            );
            await user.click(screen.getByRole("button", { name: "Preview notes.txt" }));
            expect(screen.getByRole("link", { name: "Download file" })).toHaveAttribute(
                "href",
                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb43?disposition=download"
            );
            await waitFor(() =>
                expect(screen.getByText("Bounded historical text")).toBeVisible()
            );
            expect(fetchMock).toHaveBeenCalledTimes(1);
            expect(fetchMock.mock.calls[0]?.[0]).toBe(
                "/api/chat/media/019fe633-9133-4ba0-8b80-809dd80dfb43?disposition=preview"
            );
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    test("shows running thinking but retains completed thinking only when requested", () => {
        const message = {
            attachments: [],
            id: "message-thinking",
            parts: [
                {
                    kind: "thinking" as const,
                    status: "running" as const,
                    text: "Evidence",
                },
            ],
            role: "assistant" as const,
            sequence: 1,
            sessionKey: "agent:main:main",
        };
        const rendered = render(
            <ChatMessageBubble display={display} message={message} />
        );
        expect(screen.getByText("Evidence")).toBeVisible();

        rendered.rerender(
            <ChatMessageBubble
                display={display}
                message={{
                    ...message,
                    parts: [{ ...message.parts[0]!, status: "complete" }],
                }}
            />
        );
        expect(screen.queryByText("Evidence")).toBeNull();

        rendered.rerender(
            <ChatMessageBubble
                display={{ ...display, keepThinkingAfterFinal: true }}
                message={{
                    ...message,
                    parts: [{ ...message.parts[0]!, status: "complete" }],
                }}
            />
        );
        expect(screen.getByText("Evidence")).toBeVisible();

        rendered.rerender(
            <ChatMessageBubble
                display={{
                    ...display,
                    keepThinkingAfterFinal: true,
                    showThinking: false,
                }}
                message={message}
            />
        );
        expect(screen.queryByText("Evidence")).toBeNull();
    });
});
