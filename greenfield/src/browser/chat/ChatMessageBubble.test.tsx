import { describe, expect, jest, test } from "bun:test";

import { safeChatMarkdownLink } from "./chatMarkdownPolicy.ts";
import { ChatMessageBubble } from "./ChatMessageBubble.tsx";
import { toolDisplayName } from "./chatToolPresentation.ts";

const { fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const display = {
    keepThinkingAfterFinal: false,
    showThinking: true,
    showTools: true,
    toolsExpanded: false,
};

describe("chat message bubble", () => {
    test("renders active and completed activity rows as explicit statuses", () => {
        render(
            <>
                <ChatMessageBubble
                    display={display}
                    message={{
                        attachments: [],
                        id: "activity-running",
                        parts: [
                            {
                                activity: "running",
                                kind: "control",
                                text: "Thinking…",
                                tone: "muted",
                            },
                        ],
                        role: "assistant",
                        sequence: 1,
                        sessionKey: "agent:main:main",
                        timestampMs: Date.UTC(2026, 7, 14, 20, 15),
                    }}
                />
                <ChatMessageBubble
                    display={display}
                    message={{
                        attachments: [],
                        id: "activity-complete",
                        parts: [
                            {
                                activity: "complete",
                                kind: "control",
                                text: "Context compacted",
                                tone: "muted",
                            },
                        ],
                        role: "assistant",
                        sequence: 2,
                        sessionKey: "agent:main:main",
                    }}
                />
            </>
        );

        const [thinkingMessage] = screen.getAllByRole("article", {
            name: "Mira message",
        });
        expect(within(thinkingMessage!).getByText("Mira")).toBeVisible();
        expect(within(thinkingMessage!).queryByText("Mira (thinking)")).toBeNull();
        const running = within(thinkingMessage!).getByRole("status", {
            name: "Thinking…",
        });
        expect(running).toBeVisible();
        expect(running).toHaveClass("text-sm", "[&_.loading-state-dots]:text-lg");
        expect(running.textContent).toBe("Thinking...");
        expect(thinkingMessage!.querySelector("time")).not.toBeNull();
        expect(screen.getByRole("status", { name: "Context compacted" })).toBeVisible();
    });

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

    test("keeps failed tools collapsed by default while preserving local and global expansion", async () => {
        const user = userEvent.setup();
        const message = {
            attachments: [],
            id: "message-tool",
            parts: [
                {
                    callId: "call-1",
                    error: "Unavailable",
                    kind: "tool" as const,
                    name: "status",
                    output: "Unavailable",
                    status: "failed" as const,
                },
            ],
            role: "assistant" as const,
            sequence: 1,
            sessionKey: "agent:main:main",
        };
        const rendered = render(
            <ChatMessageBubble display={display} message={message} />
        );
        const toggle = screen.getByRole("button", { name: /status failed/iu });
        expect(screen.getByRole("region", { name: "Status, failed" })).toHaveClass(
            "border-red-500/30",
            "bg-red-500/10"
        );
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(toggle.querySelector(".lucide-chevron-right")).not.toHaveClass(
            "rotate-90"
        );
        expect(toggle.querySelector(".lucide-circle-alert")).toBeNull();
        expect(within(toggle).getByText("failed")).toBeVisible();
        expect(screen.queryByRole("region", { name: "Status tool output" })).toBeNull();
        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "true");
        expect(
            screen.getByRole("region", { name: "Status tool output" })
        ).toHaveAttribute("tabindex", "0");
        await user.click(toggle);
        expect(toggle).toHaveAttribute("aria-expanded", "false");

        rendered.rerender(
            <ChatMessageBubble
                display={{ ...display, toolsExpanded: true }}
                message={message}
            />
        );
        expect(toggle).toHaveAttribute("aria-expanded", "true");
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
        expect(tool).toHaveClass("border-amber-500/30", "bg-amber-500/10");
        const toggle = screen.getByRole("button", {
            name: "Bash bun test (mira-dashboard) completed",
        });
        expect(toggle).toHaveClass("items-start");
        expect(toggle).toHaveAttribute("aria-expanded", "false");
        expect(toggle.querySelector(".lucide-chevron-right")).not.toHaveClass("mt-0.5");
        expect(toggle.querySelector(".lucide-chevron-right")).not.toHaveClass(
            "rotate-90"
        );
        expect(toggle.querySelector('[data-tool-status="completed"]')).toHaveClass(
            "mt-0.5",
            "uppercase"
        );
        expect(toggle.querySelector(".lucide-circle-check")).toBeNull();
        expect(within(tool).getByText("bun test (mira-dashboard)")).toBeVisible();
        expect(within(tool).queryByText("Tool output")).toBeNull();
        await user.click(toggle);
        expect(within(tool).getByText("Description")).toBeVisible();
        expect(within(tool).getAllByText("bun test (mira-dashboard)")).toHaveLength(1);
        expect(within(tool).getByText("Tool input")).toBeVisible();
        expect(within(tool).getByText("Tool output")).toBeVisible();
        expect(within(tool).getByText(/8 pass/iu)).toBeVisible();
        const inputRegion = within(tool).getByRole("region", {
            name: "Bash tool input",
        });
        const outputRegion = within(tool).getByRole("region", {
            name: "Bash tool output",
        });
        expect(inputRegion).toHaveAttribute("data-virtualizer-scroll-region");
        expect(inputRegion).toHaveAttribute("tabindex", "0");
        expect(outputRegion).toHaveAttribute("data-virtualizer-scroll-region");
        expect(outputRegion).toHaveAttribute("tabindex", "0");
        Object.defineProperties(inputRegion, {
            clientHeight: { configurable: true, value: 100 },
            scrollHeight: { configurable: true, value: 500 },
            scrollTop: { configurable: true, value: 0, writable: true },
        });
        fireEvent.scroll(inputRegion);
        const toBottom = within(tool).getByRole("button", {
            name: "Bash tool input: scroll to bottom",
        });
        await user.click(toBottom);
        expect(inputRegion.scrollTop).toBe(500);
        expect(toggle.querySelector(".lucide-chevron-right")).toHaveClass("rotate-90");
        expect(within(tool).queryByText("running")).toBeNull();
    });

    test("highlights structured tool data without interpreting plain output as Markdown", () => {
        render(
            <ChatMessageBubble
                display={{ ...display, toolsExpanded: true }}
                message={{
                    attachments: [],
                    id: "message-tool-source",
                    parts: [
                        {
                            callId: "call-json",
                            input: { query: "select 1", values: [1, true] },
                            kind: "tool",
                            name: "database_query",
                            output: '{"rows":[{"healthy":true}]}',
                            status: "completed",
                        },
                        {
                            callId: "call-plain",
                            input: "printf '# literal'",
                            kind: "tool",
                            name: "functions.exec_command",
                            output: "# Not a heading\n**not emphasized**",
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const jsonTool = screen.getByRole("region", {
            name: "Database query, completed",
        });
        const jsonInput = within(jsonTool).getByRole("region", {
            name: "Database query tool input",
        });
        const jsonOutput = within(jsonTool).getByRole("region", {
            name: "Database query tool output",
        });
        expect(
            within(jsonInput).getByTestId("syntax-highlighted-source")
        ).toHaveAttribute("data-language", "json");
        expect(
            within(jsonOutput).getByTestId("syntax-highlighted-source")
        ).toHaveAttribute("data-language", "json");

        const plainTool = screen.getByRole("region", { name: "Bash, completed" });
        const plainOutput = within(plainTool).getByRole("region", {
            name: "Bash tool output",
        });
        expect(
            plainOutput.querySelector('[data-language="plaintext"]')?.textContent
        ).toBe("# Not a heading\n**not emphasized**");
        expect(within(plainOutput).queryByRole("heading")).toBeNull();
        expect(within(plainOutput).queryByTestId("syntax-highlighted-source")).toBeNull();
    });

    test("unwraps browser result content into highlighted and readable blocks", () => {
        render(
            <ChatMessageBubble
                display={{ ...display, toolsExpanded: true }}
                message={{
                    attachments: [],
                    id: "message-browser-tool",
                    parts: [
                        {
                            callId: "call-browser",
                            input: {
                                action: "navigate",
                                targetId: "greenfield-apply-patch-diff",
                            },
                            kind: "tool",
                            name: "openclaw__browser",
                            output: JSON.stringify({
                                content: [
                                    {
                                        text: JSON.stringify({
                                            ok: true,
                                            targetId: "browser-target",
                                        }),
                                        type: "text",
                                    },
                                    {
                                        text: "SECURITY NOTICE\n- Untrusted content",
                                        type: "text",
                                    },
                                ],
                            }),
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const output = screen.getByRole("region", {
            name: /browser tool output/iu,
        });
        expect(within(output).getByTestId("syntax-highlighted-source")).toHaveAttribute(
            "data-language",
            "json"
        );
        expect(output).toHaveTextContent("browser-target");
        expect(output).toHaveTextContent("SECURITY NOTICE");
        expect(output).toHaveTextContent("- Untrusted content");
        expect(output).not.toHaveTextContent('"content"');
    });

    test("highlights numbered command output per source file", () => {
        render(
            <ChatMessageBubble
                display={{ ...display, toolsExpanded: true }}
                message={{
                    attachments: [],
                    id: "message-numbered-source-tool",
                    parts: [
                        {
                            callId: "call-numbered-source",
                            input: {
                                command:
                                    "/bin/bash -lc \"nl -ba package.json | sed -n '1,3p'; nl -ba src/browser/auth/PasswordLoginForm.tsx | sed -n '27,28p'\"",
                                cwd: "/workspace",
                            },
                            kind: "tool",
                            name: "functions.exec_command",
                            output: ` 1 {
 2   "name": "mira-dashboard"
 3 }
 27 return (
 28   <LoginPanel>`,
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const output = screen.getByRole("region", { name: "Bash tool output" });
        expect(within(output).getByText("package.json · lines 1–3")).toBeVisible();
        expect(
            within(output).getByText(
                "src/browser/auth/PasswordLoginForm.tsx · lines 27–28"
            )
        ).toBeVisible();
        expect(
            within(output)
                .getAllByTestId("syntax-highlighted-source")
                .map((source) => source.dataset.language)
        ).toEqual(["json", "typescript"]);
        expect(output.querySelector(".hljs-attr")).not.toBeNull();
        expect(output.querySelector(".hljs-keyword")).not.toBeNull();
    });

    test("renders apply-patch input as a colored file diff", async () => {
        render(
            <ChatMessageBubble
                display={{ ...display, toolsExpanded: true }}
                message={{
                    attachments: [],
                    id: "message-apply-patch",
                    parts: [
                        {
                            callId: "call-patch",
                            input: {
                                patch: `*** Begin Patch
*** Update File: src/example.ts
@@ -8,2 +8,2 @@
-const color = "gray";
+const color = "green";
 export { color };
*** End Patch`,
                            },
                            kind: "tool",
                            name: "functions.apply_patch",
                            output: "Done!",
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
            name: "Apply patch, completed",
        });
        const diff = within(tool).getByRole("figure", {
            name: "Apply patch file changes",
        });
        expect(within(diff).getByText("src/example.ts")).toBeVisible();
        expect(within(diff).getByText("+1")).toHaveClass("text-emerald-300");
        expect(within(diff).getByText("-1")).toHaveClass("text-red-300");
        await waitFor(() =>
            expect(diff.querySelector('[data-diff-line="add"]')).not.toBeNull()
        );
        expect(diff.querySelector('[data-diff-line="add"]')).toHaveClass(
            "bg-emerald-500/10"
        );
        expect(diff.querySelector('[data-diff-line="delete"]')).toHaveClass(
            "bg-red-500/10"
        );
        expect(within(diff).getAllByTestId("syntax-highlighted-source")).not.toHaveLength(
            0
        );
        for (const source of within(diff).getAllByTestId("syntax-highlighted-source")) {
            expect(source).toHaveAttribute("data-language", "typescript");
        }
        expect(within(tool).queryByText("Description")).toBeNull();
        expect(within(tool).queryByText("Tool input")).toBeNull();
        expect(within(tool).getByText("Tool output")).toBeVisible();
    });

    test("bounds collapsed tool summaries without exposing unrelated input or output", () => {
        const command = `bun test ${"safe ".repeat(40)}`;
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-bounded-tool-summary",
                    parts: [
                        {
                            callId: "call-bounded",
                            input: {
                                cmd: `  ${command}\n`,
                                secret: "input-secret",
                            },
                            kind: "tool",
                            name: "functions.exec_command",
                            output: "output-secret",
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const tool = screen.getByRole("region", { name: "Bash, completed" });
        const summary = within(tool).getByText(/^bun test safe/iu);
        expect(summary.textContent).not.toContain("\n");
        // oxlint-disable-next-line unicorn/prefer-spread -- The summary contract is explicitly bounded in Unicode code points.
        expect(Array.from(summary.textContent ?? "")).toHaveLength(120);
        expect(within(tool).queryByText("input-secret")).toBeNull();
        expect(within(tool).queryByText("output-secret")).toBeNull();
        expect(tool.getAttribute("aria-label")).toBe("Bash, completed");
    });

    test("strips Unicode controls from summaries while retaining full tool input", async () => {
        const user = userEvent.setup();
        const command = "bun\u202E test\u0007 --safe";
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-controlled-tool-summary",
                    parts: [
                        {
                            callId: "call-controlled",
                            input: { cmd: command },
                            kind: "tool",
                            name: "functions.exec_command",
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const tool = screen.getByRole("region", { name: "Bash, completed" });
        const toggle = within(tool).getByRole("button", {
            name: "Bash bun test --safe completed",
        });
        expect(toggle.textContent).not.toContain("\u202E");
        expect(toggle.textContent).not.toContain("\u0007");
        await user.click(toggle);
        const fullInput = within(tool).getByRole("region", {
            name: "Bash tool input",
        }).textContent;
        expect(fullInput).toContain("\u202E");
        expect(fullInput).toContain(String.raw`\u0007`);
    });

    test("bounds and strips Unicode controls from tool names and accessible labels", () => {
        const name = `functions.unsafe\u202E_tool\u0007_${"x".repeat(160)}`;
        const label = toolDisplayName(name);
        expect(label).toHaveLength(120);
        expect(label).not.toContain("\u202E");
        expect(label).not.toContain("\u0007");
        const expandingLabel = toolDisplayName(`ß${"x".repeat(119)}`);
        expect(expandingLabel).toHaveLength(120);
        expect(expandingLabel.startsWith("SS")).toBeTrue();
        expect(expandingLabel.endsWith("…")).toBeTrue();
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-controlled-tool-name",
                    parts: [
                        {
                            callId: "call-controlled-name",
                            kind: "tool",
                            name,
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const tool = screen.getByRole("region", { name: `${label}, completed` });
        expect(within(tool).getByRole("button")).toHaveAccessibleName(
            `${label} completed`
        );
    });

    test("derives tool descriptions only from valid structured string input", () => {
        render(
            <ChatMessageBubble
                display={{ ...display, toolsExpanded: true }}
                message={{
                    attachments: [],
                    id: "message-string-tool-input",
                    parts: [
                        {
                            callId: "call-path",
                            input: '{"path":"/workspace/report.txt"}',
                            kind: "tool",
                            name: "read_file",
                            status: "completed",
                        },
                        {
                            callId: "call-malformed",
                            input: "not-json",
                            kind: "tool",
                            name: "inspect",
                            status: "completed",
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        const fileTool = screen.getByRole("region", {
            name: "Read file, completed",
        });
        expect(within(fileTool).getByText("Description").parentElement).toHaveTextContent(
            "/workspace/report.txt"
        );
        expect(
            within(
                screen.getByRole("region", { name: "Inspect, completed" })
            ).queryByText("Description")
        ).toBeNull();
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
        expect(screen.getByText("Private working surface").closest("aside")).toHaveClass(
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

    test("does not offer read aloud for a text-only streaming provider run", () => {
        render(
            <ChatMessageBubble
                activeRunIds={["provider-run-active"]}
                display={display}
                message={{
                    attachments: [],
                    id: "streaming-provider-text",
                    parts: [{ kind: "text", text: "Partial provider answer" }],
                    providerRunId: "provider-run-active",
                    role: "assistant",
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

    test("renders thinking through the shared safe Markdown and syntax pipeline", () => {
        render(
            <ChatMessageBubble
                display={display}
                message={{
                    attachments: [],
                    id: "message-thinking-markdown",
                    parts: [
                        {
                            kind: "thinking",
                            status: "running",
                            text: [
                                "## Working plan",
                                "",
                                "Inspect `chat.history` before reconciling.",
                                "",
                                "```json",
                                '{"next":"inspect"}',
                                "```",
                            ].join("\n"),
                        },
                    ],
                    role: "assistant",
                    sequence: 1,
                    sessionKey: "agent:main:main",
                }}
            />
        );

        expect(screen.getByRole("heading", { name: "Working plan" })).toBeVisible();
        expect(screen.getByText("Mira (thinking)")).toBeVisible();
        expect(screen.queryByText("Thinking…")).toBeNull();
        expect(screen.queryByRole("status", { name: "Thinking…" })).toBeNull();
        const inlineCode = screen.getByText("chat.history", { selector: "code" });
        expect(inlineCode).toHaveClass(
            "rounded",
            "bg-black/25",
            "px-1",
            "py-0.5",
            "font-mono",
            "text-[0.92em]"
        );
        expect(inlineCode.closest("pre")).toBeNull();
        expect(screen.getByTestId("syntax-highlighted-source")).toHaveAttribute(
            "data-language",
            "json"
        );
    });

    test("styles inline code consistently in user and final Markdown", () => {
        render(
            <>
                <ChatMessageBubble
                    display={display}
                    message={{
                        attachments: [],
                        id: "message-user-inline-code",
                        parts: [{ kind: "text", text: "Run `bun test` now." }],
                        role: "user",
                        sequence: 1,
                        sessionKey: "agent:main:main",
                    }}
                />
                <ChatMessageBubble
                    display={display}
                    message={{
                        attachments: [],
                        id: "message-final-inline-code",
                        parts: [{ kind: "text", text: "Returned `exitCode=0`." }],
                        role: "assistant",
                        sequence: 2,
                        sessionKey: "agent:main:main",
                    }}
                />
            </>
        );

        for (const content of ["bun test", "exitCode=0"]) {
            const inlineCode = screen.getByText(content, { selector: "code" });
            expect(inlineCode).toHaveClass(
                "rounded",
                "bg-black/25",
                "px-1",
                "py-0.5",
                "font-mono",
                "text-[0.92em]"
            );
            expect(inlineCode.closest("pre")).toBeNull();
        }
    });
});
