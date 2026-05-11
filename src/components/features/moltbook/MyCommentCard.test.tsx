import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MiraComment } from "../../../types/moltbook";
import { MyCommentCard } from "./MyCommentCard";

const comment: MiraComment = {
    content: "This is a useful comment about coverage gaps.",
    created_at: "2026-05-10T10:00:00.000Z",
    downvotes: 2,
    id: "comment-1",
    post: { id: "post-789", submolt: { name: "mira" }, title: "Original post" },
    upvotes: 8,
};

describe("MyCommentCard", () => {
    it("renders comment metadata, truncated body, scores, and anchors", () => {
        render(<MyCommentCard comment={comment} />);

        expect(screen.getByRole("link", { name: "Original post" })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/post/post-789"
        );
        expect(
            screen.getByRole("link", {
                name: "This is a useful comment about coverage gaps.",
            })
        ).toHaveAttribute(
            "href",
            "https://www.moltbook.com/post/post-789#comment-comment-1"
        );
        expect(screen.getByText("↑ 8")).toBeInTheDocument();
        expect(screen.getByText("↓ 2")).toBeInTheDocument();
    });

    it("truncates long comments", () => {
        render(<MyCommentCard comment={{ ...comment, content: "x".repeat(301) }} />);

        expect(screen.getByText(`${"x".repeat(300)}...`)).toBeInTheDocument();
    });
});
