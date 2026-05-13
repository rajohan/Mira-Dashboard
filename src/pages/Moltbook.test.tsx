import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Moltbook } from "./Moltbook";

const hooks = vi.hoisted(() => ({
    refetch: vi.fn(),
    useMoltbookData: vi.fn(),
}));

vi.mock("../hooks", () => ({
    useMoltbookData: hooks.useMoltbookData,
}));

vi.mock("../components/features/moltbook", () => ({
    FeedPostCard: ({ post }: { post: { id: string; title: string } }) => (
        <article data-testid="feed-post">feed: {post.title}</article>
    ),
    MyCommentCard: ({ comment }: { comment: { id: string; body: string } }) => (
        <article data-testid="my-comment">comment: {comment.body}</article>
    ),
    MyPostCard: ({ post }: { post: { id: string; title: string } }) => (
        <article data-testid="my-post">post: {post.title}</article>
    ),
    ProfileCard: ({
        profile,
        unreadCount,
    }: {
        profile: { username: string };
        unreadCount: number;
    }) => (
        <section data-testid="profile-card">
            {profile.username}, unread: {unreadCount}
        </section>
    ),
}));

function mockMoltbookData(overrides = {}) {
    hooks.useMoltbookData.mockReturnValue({
        error: null,
        home: { unreadMessageCount: 3 },
        isLoading: false,
        myContent: {
            comments: [{ body: "Nice work", id: "comment-1" }],
            posts: [{ id: "my-post-1", title: "My post" }],
        },
        posts: [{ id: "feed-1", title: "Feed post" }],
        profile: { username: "mira_2026" },
        refetch: hooks.refetch,
        ...overrides,
    });
}

describe("Moltbook page", () => {
    beforeEach(() => {
        hooks.refetch.mockReset();
        hooks.useMoltbookData.mockReset();
        mockMoltbookData();
    });

    it("renders loading state", () => {
        mockMoltbookData({ isLoading: true });

        const { container } = render(<Moltbook />);

        expect(container.querySelector(".animate-spin")).toBeInTheDocument();
    });

    it("renders error state and retries", async () => {
        const user = userEvent.setup();
        mockMoltbookData({ error: "Moltbook unavailable" });

        render(<Moltbook />);

        expect(screen.getByText("Moltbook unavailable")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Retry" }));
        expect(hooks.refetch).toHaveBeenCalledTimes(1);
    });

    it("defaults unread count when home metadata is unavailable", () => {
        mockMoltbookData({ home: undefined });

        render(<Moltbook />);

        expect(screen.getByTestId("profile-card")).toHaveTextContent(
            "mira_2026, unread: 0"
        );
    });

    it("renders profile and feed posts by default", () => {
        render(<Moltbook />);

        expect(screen.getByTestId("profile-card")).toHaveTextContent(
            "mira_2026, unread: 3"
        );
        expect(screen.getByTestId("feed-post")).toHaveTextContent("feed: Feed post");
        expect(hooks.useMoltbookData).toHaveBeenCalledWith("hot");
    });

    it("switches feed sort", async () => {
        const user = userEvent.setup();

        render(<Moltbook />);

        await user.click(screen.getByRole("button", { name: "New" }));
        expect(hooks.useMoltbookData).toHaveBeenLastCalledWith("new");
    });

    it("switches between my posts and comments tabs", async () => {
        const user = userEvent.setup();

        render(<Moltbook />);

        await user.click(screen.getByRole("button", { name: "Posts" }));
        expect(screen.getByTestId("my-post")).toHaveTextContent("post: My post");

        await user.click(screen.getByRole("button", { name: "Comments" }));
        expect(screen.getByTestId("my-comment")).toHaveTextContent("comment: Nice work");
    });

    it("renders empty state when my content has not loaded", async () => {
        const user = userEvent.setup();
        mockMoltbookData({ myContent: undefined });

        render(<Moltbook />);

        await user.click(screen.getByRole("button", { name: "Posts" }));
        expect(screen.getByText("No posts yet.")).toBeInTheDocument();
    });

    it("renders empty states for empty content", async () => {
        const user = userEvent.setup();
        mockMoltbookData({
            myContent: { comments: [], posts: [] },
            posts: [],
        });

        render(<Moltbook />);

        expect(screen.getByText("No posts yet.")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Comments" }));
        expect(screen.getByText("No comments yet.")).toBeInTheDocument();
    });
});
