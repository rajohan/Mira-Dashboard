import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ChatMarkdown } from "../../components/features/chat/ChatMarkdown";
import {
    childrenToText,
    getPreCodeBlock,
} from "../../components/features/chat/chatMarkdownUtilities";
import { CronJobList } from "../../components/features/cron/CronJobList";
import { PreviewToggle } from "../../components/features/files/PreviewToggle";
import { CodePreview } from "../../components/features/files/viewers/CodePreview";
import { JsonPreview } from "../../components/features/files/viewers/JsonPreview";
import { MarkdownPreview } from "../../components/features/files/viewers/MarkdownPreview";
import { LogLine } from "../../components/features/logs/LogLine";
import { MyCommentCard } from "../../components/features/moltbook/MyCommentCard";
import { MyPostCard } from "../../components/features/moltbook/MyPostCard";
import { ProfileCard } from "../../components/features/moltbook/ProfileCard";
import { SessionActionsDropdown } from "../../components/features/sessions/SessionActionsDropdown";
import { Alert } from "../../components/ui/Alert";
import { AppErrorFallback } from "../../components/ui/AppErrorFallback";
import { Badge } from "../../components/ui/Badge";
import { Checkbox } from "../../components/ui/Checkbox";
import { ConnectionStatus } from "../../components/ui/ConnectionStatus";
import { CopyButton } from "../../components/ui/CopyButton";
import { ExpandableCard, ReadOnlyField } from "../../components/ui/ExpandableCard";
import { FilterButtonGroup } from "../../components/ui/FilterButtonGroup";
import { ProgressBar } from "../../components/ui/ProgressBar";
import { getProgressColor } from "../../utils/progressUtilities";
import { getSessionTypeVariant } from "../../utils/sessionUtilities";
const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};
function TestIcon({ size, className }: { className?: string; size?: number }) {
    return (
        <span className={className} data-size={size}>
            I
        </span>
    );
}
function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}
function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}
beforeEach(() => {
    Object.defineProperties(globalThis, {
        requestAnimationFrame: {
            configurable: true,
            value: requestAnimationFrameForTest,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: cancelAnimationFrameForTest,
            writable: true,
        },
    });
});
afterEach(() => {
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
    });
    animationFrameState.frames.clear();
});
describe("Dashboard shared components", () => {
    it("names filter button groups and exposes their selected option", () => {
        render(
            <FilterButtonGroup
                ariaLabel="Example filter"
                options={[
                    {
                        value: "all",
                        label: "All",
                    },
                    {
                        value: "active",
                        label: "Active",
                    },
                ]}
                value="active"
                onChange={() => {}}
            />
        );
        const filterGroup = screen.getByRole("group", {
            name: "Example filter",
        });
        expect(filterGroup).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "All",
            })
        ).toHaveAttribute("aria-pressed", "false");
        expect(
            screen.getByRole("button", {
                name: "Active",
            })
        ).toHaveAttribute("aria-pressed", "true");
    });
    it("flattens nested React children and detects fenced code blocks", () => {
        expect(
            childrenToText([
                "hello ",
                <span key="world">world</span>,
                [<strong key="bang">!</strong>, 7],
            ])
        ).toBe("hello world!7");
        expect(
            getPreCodeBlock(
                <code className="language-ts">{["const answer = 42;\n"]}</code>
            )
        ).toEqual({
            code: "const answer = 42;",
            language: "ts",
        });
        expect(getPreCodeBlock(<span>plain</span>)).toEqual({
            code: "plain",
            language: "text",
        });
        expect(getPreCodeBlock("plain")).toBeUndefined();
    });
    it("renders markdown links, images, tables, fallbacks, and code blocks", () => {
        render(
            <ChatMarkdown
                text={[
                    "[link](https://example.test)",
                    "![Dashboard image](https://example.test/image.png)",
                    "> quoted",
                    "",
                    "| A |",
                    "| - |",
                    "| B |",
                    "",
                    "`inline`",
                    "",
                    "```json",
                    "{value: 1}",
                    "```",
                    "",
                    "```sh",
                    "echo ok",
                    "```",
                ].join("\n")}
            />
        );
        expect(
            screen.getByRole("link", {
                name: "link",
            })
        ).toHaveAttribute("target", "_blank");
        expect(
            screen.getByRole("link", {
                name: "Dashboard image",
            })
        ).toHaveAttribute("href", "https://example.test/image.png");
        expect(screen.getByText("quoted")).toBeInTheDocument();
        expect(screen.getByText("inline")).toBeInTheDocument();
        expect(screen.getByText("json")).toBeInTheDocument();
        expect(screen.getByText("sh")).toBeInTheDocument();
    });
    it("copies chat code and structured file previews", async () => {
        const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "clipboard"
        );
        const writeText = jest.fn(async () => {});
        const user = userEvent.setup();
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: {
                writeText,
            },
        });
        const view = render(<ChatMarkdown text={'```json\n{"value":1}\n```'} />);
        try {
            await user.click(
                screen.getByRole("button", {
                    name: "Copy code",
                })
            );
            await waitFor(() => {
                expect(writeText).toHaveBeenLastCalledWith('{"value":1}');
            });
            view.rerender(<JsonPreview content={'{"value": 1}'} />);
            await user.click(
                screen.getByRole("button", {
                    name: "Copy JSON",
                })
            );
            await waitFor(() => {
                expect(writeText).toHaveBeenLastCalledWith('{"value": 1}');
            });
            view.rerender(<CodePreview language="ts" content="const value = 1;" />);
            await user.click(
                screen.getByRole("button", {
                    name: "Copy code",
                })
            );
            await waitFor(() => {
                expect(writeText).toHaveBeenLastCalledWith("const value = 1;");
            });
            view.rerender(<MarkdownPreview content="# Notes" />);
            await user.click(
                screen.getByRole("button", {
                    name: "Copy Markdown",
                })
            );
            await waitFor(() => {
                expect(writeText).toHaveBeenLastCalledWith("# Notes");
            });
        } finally {
            view.unmount();
            if (originalClipboardDescriptor) {
                Object.defineProperty(
                    navigator,
                    "clipboard",
                    originalClipboardDescriptor
                );
            } else {
                Reflect.deleteProperty(navigator, "clipboard");
            }
        }
    });
    it("reports when clipboard copying is unavailable", async () => {
        const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
            navigator,
            "clipboard"
        );
        const user = userEvent.setup();
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: undefined,
        });
        const view = render(<CopyButton content="notes" label="Copy notes" />);
        try {
            await user.click(
                screen.getByRole("button", {
                    name: "Copy notes",
                })
            );
            expect(
                await screen.findByRole("button", {
                    name: "Copy failed",
                })
            ).toBeInTheDocument();
        } finally {
            view.unmount();
            if (originalClipboardDescriptor) {
                Object.defineProperty(
                    navigator,
                    "clipboard",
                    originalClipboardDescriptor
                );
            } else {
                Reflect.deleteProperty(navigator, "clipboard");
            }
        }
    });
    it("renders alert variants, right-aligned dismissal, and clamped progress", async () => {
        const onDismiss = jest.fn();
        expect(getProgressColor(10)).toBe("green");
        expect(getProgressColor(50)).toBe("blue");
        expect(getProgressColor(89)).toBe("orange");
        expect(getProgressColor(99)).toBe("red");
        render(
            <>
                <Alert
                    dismissLabel="Dismiss saved message"
                    onDismiss={onDismiss}
                    variant="success"
                    title="Saved"
                >
                    Done
                </Alert>
                <Alert variant="warning">Careful</Alert>
                <ProgressBar percent={140} color="purple" size="sm" />
            </>
        );
        expect(screen.getByText("Saved")).toBeInTheDocument();
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.getByText("Careful")).toBeInTheDocument();
        const dismiss = screen.getByRole("button", {
            name: "Dismiss saved message",
        });
        expect(dismiss).toHaveClass("ml-auto", "shrink-0", "self-start");
        expect(dismiss.parentElement?.lastElementChild).toBe(dismiss);
        await userEvent.click(dismiss);
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(document.querySelector(".bg-purple-500")).toHaveStyle({
            width: "100%",
        });
    });
    it("renders standalone UI primitives and fallback states", async () => {
        const user = userEvent.setup();
        const onCheck = jest.fn();
        const onReset = jest.fn();
        render(
            <>
                <Badge variant="main">Main session</Badge>
                <Badge variant={getSessionTypeVariant("subagent")}>Worker</Badge>
                <Checkbox
                    isChecked={false}
                    onChange={onCheck}
                    label="Enable option"
                    description="Toggle this option"
                />
                <ConnectionStatus isConnected={true} connectedText="Online" />
                <ConnectionStatus isConnected={false} disconnectedText="Offline" />
                <ExpandableCard
                    title="Expanded panel"
                    icon={TestIcon}
                    defaultExpanded={true}
                >
                    <ReadOnlyField label="Current value" value={undefined} />
                    <ReadOnlyField label="Boolean value" value={true} />
                </ExpandableCard>
                <AppErrorFallback
                    error={new Error("Rendered failure")}
                    resetErrorBoundary={onReset}
                />
            </>
        );
        expect(screen.getByText("Main session")).toBeInTheDocument();
        expect(screen.getByText("Worker")).toBeInTheDocument();
        expect(screen.getByText("Online")).toBeInTheDocument();
        expect(screen.getByText("Offline")).toBeInTheDocument();
        expect(screen.getByText("Expanded panel")).toBeInTheDocument();
        expect(screen.getByText("Current value")).toBeInTheDocument();
        expect(screen.getByText("Boolean value")).toBeInTheDocument();
        expect(screen.getByText("Rendered failure")).toBeInTheDocument();
        await user.click(screen.getByText("Enable option"));
        expect(onCheck).toHaveBeenCalledWith(true);
        await user.click(
            screen.getByRole("button", {
                name: /try again/i,
            })
        );
        expect(onReset).toHaveBeenCalled();
    });
    it("renders file preview, log, session, cron, and Moltbook cards", async () => {
        const user = userEvent.setup();
        const onToggle = jest.fn();
        const onCompact = jest.fn();
        const onReset = jest.fn();
        const onDelete = jest.fn();
        const onSelect = jest.fn();
        render(
            <>
                <PreviewToggle
                    isPreview={false}
                    onToggle={onToggle}
                    previewLabel="Preview file"
                    editLabel="Raw file"
                />
                <LogLine
                    log={{
                        id: "log-1",
                        level: "info",
                        msg: "Started",
                        raw: "",
                        subsystem: "api",
                        ts: "2026-06-24T10:00:00.000Z",
                    }}
                />
                <SessionActionsDropdown
                    onCompact={onCompact}
                    onReset={onReset}
                    onDelete={onDelete}
                />
                <CronJobList
                    selectedId=""
                    currentJobId="heartbeat"
                    onSelect={onSelect}
                    jobs={[
                        {
                            enabled: true,
                            id: "heartbeat",
                            name: "Heartbeat",
                            state: {
                                lastRunAtMs: 1_719_216_000_000,
                                nextRunAtMs: 1_719_219_600_000,
                            },
                        },
                        {
                            enabled: false,
                            id: "cleanup",
                            name: "Cleanup",
                            state: {},
                        },
                    ]}
                />
                <MyPostCard
                    post={{
                        comment_count: 3,
                        content_preview: "Post preview",
                        created_at: "2026-06-24T10:00:00.000Z",
                        downvotes: 1,
                        id: "42",
                        submolt: {
                            name: "dashboard",
                        },
                        title: "Coverage post",
                        upvotes: 7,
                    }}
                />
                <MyCommentCard
                    comment={{
                        content: "Comment body",
                        created_at: "2026-06-24T10:00:00.000Z",
                        downvotes: 0,
                        id: "9",
                        post: {
                            id: "42",
                            submolt: {
                                name: "dashboard",
                            },
                            title: "Coverage post",
                        },
                        upvotes: 4,
                    }}
                />
                <ProfileCard
                    unreadCount={2}
                    profile={{
                        avatar_url: "",
                        description: "Dashboard agent",
                        display_name: "Mira",
                        follower_count: 11,
                        following_count: 5,
                        karma: 99,
                        name: "mira_2026",
                        comments_count: 8,
                        posts_count: 6,
                    }}
                />
                <ProfileCard
                    unreadCount={0}
                    profile={{
                        avatar_url: "https://example.test/avatar.png",
                        description: "With avatar",
                        display_name: "",
                        follower_count: 1,
                        following_count: 2,
                        karma: 3,
                        name: "mira_avatar",
                        comments_count: 4,
                        posts_count: 5,
                    }}
                />
            </>
        );
        const previewButton = screen.getByRole("button", {
            name: /preview file/i,
        });
        const rawButton = screen.getByRole("button", {
            name: /raw file/i,
        });
        expect(previewButton).toHaveAttribute("aria-pressed", "false");
        expect(rawButton).toHaveAttribute("aria-pressed", "true");
        fireEvent.click(previewButton);
        fireEvent.click(rawButton);
        expect(onToggle).toHaveBeenNthCalledWith(1, true);
        expect(onToggle).toHaveBeenNthCalledWith(2, false);
        expect(screen.getByText("INFO")).toBeInTheDocument();
        expect(screen.getByText("[api]")).toBeInTheDocument();
        expect(screen.getByText("Started")).toBeInTheDocument();
        await user.click(
            screen.getByRole("button", {
                name: /session actions/i,
            })
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /compact/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /session actions/i,
            })
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /reset/i,
            })
        );
        await user.click(
            screen.getByRole("button", {
                name: /session actions/i,
            })
        );
        await user.click(
            screen.getByRole("menuitem", {
                name: /delete/i,
            })
        );
        expect(onCompact).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);
        fireEvent.click(
            screen.getByRole("button", {
                name: /cleanup/i,
            })
        );
        expect(onSelect).toHaveBeenCalledWith("cleanup");
        expect(screen.getAllByText("Coverage post").length).toBeGreaterThan(0);
        expect(screen.getByText("Comment body")).toBeInTheDocument();
        expect(screen.getByText("2 new")).toBeInTheDocument();
        expect(screen.getByAltText("mira_avatar")).toHaveAttribute(
            "src",
            "https://example.test/avatar.png"
        );
    });
});
