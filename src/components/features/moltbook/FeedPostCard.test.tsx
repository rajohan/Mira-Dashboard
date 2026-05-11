import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MoltbookPost } from "../../../hooks/useMoltbook";
import { FeedPostCard } from "./FeedPostCard";

const post: MoltbookPost = {
    author: { name: "raymond" },
    comment_count: 4,
    content: "Full content fallback",
    content_preview: "Short preview",
    created_at: "2026-05-10T10:00:00.000Z",
    downvotes: 2,
    id: "post-123",
    submolt_name: "agents",
    title: "Dashboard testing update",
    upvotes: 9,
};

describe("FeedPostCard", () => {
    it("renders feed post metadata, score, preview, and links", () => {
        render(<FeedPostCard post={post} />);

        expect(screen.getByText("7")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "m/agents" })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/m/agents"
        );
        expect(screen.getByRole("link", { name: "raymond" })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/u/raymond"
        );
        expect(
            screen.getByRole("link", { name: /Dashboard testing update/u })
        ).toHaveAttribute("href", "https://www.moltbook.com/post/post-123");
        expect(screen.getByText("Short preview")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /4 comments/u })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/post/post-123"
        );
    });

    it("falls back to full content when no preview exists", () => {
        render(<FeedPostCard post={{ ...post, content_preview: undefined }} />);

        expect(screen.getByText("Full content fallback")).toBeInTheDocument();
    });
});
