import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import {
    ChatMarkdown,
    childrenToText,
    getPreCodeBlock,
    markdownComponents,
} from "./components/features/chat/ChatMarkdown";
import { CronJobList } from "./components/features/cron/CronJobList";
import { PreviewToggle } from "./components/features/files/PreviewToggle";
import { LogLine } from "./components/features/logs/LogLine";
import { MyCommentCard } from "./components/features/moltbook/MyCommentCard";
import { MyPostCard } from "./components/features/moltbook/MyPostCard";
import { ProfileCard } from "./components/features/moltbook/ProfileCard";
import { SessionActionsDropdown } from "./components/features/sessions/SessionActionsDropdown";
import { Alert } from "./components/ui/Alert";
import { getProgressColor, ProgressBar } from "./components/ui/ProgressBar";

describe("shared component helpers", () => {
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
        const renderImage = markdownComponents.img as (properties: {
            alt?: string;
            node: unknown;
            src?: string;
        }) => unknown;
        const image = renderImage({
            alt: "Dashboard image",
            node: undefined,
            src: "https://example.test/image.png",
        });
        const missingImage = renderImage({
            alt: "",
            node: undefined,
            src: "",
        });

        expect(image).toBeTruthy();
        expect(missingImage).toBeUndefined();

        render(
            <ChatMarkdown
                text={[
                    "[link](https://example.test)",
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

        expect(screen.getByRole("link", { name: "link" })).toHaveAttribute(
            "target",
            "_blank"
        );
        expect(screen.getByText("quoted")).toBeInTheDocument();
        expect(screen.getByText("inline")).toBeInTheDocument();
        expect(screen.getByText("json")).toBeInTheDocument();
        expect(screen.getByText("sh")).toBeInTheDocument();
    });

    it("renders alert variants and clamps progress bar width", () => {
        expect(getProgressColor(10)).toBe("green");
        expect(getProgressColor(50)).toBe("blue");
        expect(getProgressColor(89)).toBe("orange");
        expect(getProgressColor(99)).toBe("red");

        render(
            <>
                <Alert variant="success" title="Saved">
                    Done
                </Alert>
                <Alert variant="warning">Careful</Alert>
                <ProgressBar percent={140} color="purple" size="sm" />
            </>
        );

        expect(screen.getByText("Saved")).toBeInTheDocument();
        expect(screen.getByText("Done")).toBeInTheDocument();
        expect(screen.getByText("Careful")).toBeInTheDocument();
        expect(document.querySelector(".bg-purple-500")).toHaveStyle({
            width: "100%",
        });
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
                        { enabled: false, id: "cleanup", name: "Cleanup", state: {} },
                    ]}
                />
                <MyPostCard
                    post={{
                        comment_count: 3,
                        content_preview: "Post preview",
                        created_at: "2026-06-24T10:00:00.000Z",
                        downvotes: 1,
                        id: "42",
                        submolt: { name: "dashboard" },
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
                            submolt: { name: "dashboard" },
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

        fireEvent.click(screen.getByRole("button", { name: /preview file/i }));
        fireEvent.click(screen.getByRole("button", { name: /raw file/i }));
        expect(onToggle).toHaveBeenNthCalledWith(1, true);
        expect(onToggle).toHaveBeenNthCalledWith(2, false);

        expect(screen.getByText("INFO")).toBeInTheDocument();
        expect(screen.getByText("[api]")).toBeInTheDocument();
        expect(screen.getByText("Started")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: /session actions/i }));
        await user.click(screen.getByRole("menuitem", { name: /compact/i }));
        await user.click(screen.getByRole("button", { name: /session actions/i }));
        await user.click(screen.getByRole("menuitem", { name: /reset/i }));
        await user.click(screen.getByRole("button", { name: /session actions/i }));
        await user.click(screen.getByRole("menuitem", { name: /delete/i }));
        expect(onCompact).toHaveBeenCalledTimes(1);
        expect(onReset).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledTimes(1);

        fireEvent.click(screen.getByRole("button", { name: /cleanup/i }));
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
