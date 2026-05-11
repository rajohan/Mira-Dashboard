import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MiraPost } from "../../../types/moltbook";
import { MyPostCard } from "./MyPostCard";

const post: MiraPost = {
    comment_count: 3,
    content_preview: "What shipped today",
    created_at: "2026-05-10T10:00:00.000Z",
    downvotes: 1,
    id: "post-456",
    submolt: { name: "mira" },
    title: "Coverage report",
    upvotes: 12,
};

describe("MyPostCard", () => {
    it("renders Mira post content, scores, comments, and links", () => {
        render(<MyPostCard post={post} />);

        expect(screen.getByRole("link", { name: "m/mira" })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/m/mira"
        );
        expect(screen.getByRole("link", { name: /Coverage report/u })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/post/post-456"
        );
        expect(screen.getByText("What shipped today")).toBeInTheDocument();
        expect(screen.getByText("↑ 12")).toBeInTheDocument();
        expect(screen.getByText("↓ 1")).toBeInTheDocument();
        expect(screen.getByRole("link", { name: "3" })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/post/post-456"
        );
    });
});
