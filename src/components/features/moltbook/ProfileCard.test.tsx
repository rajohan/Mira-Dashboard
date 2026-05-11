import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MiraProfile } from "../../../types/moltbook";
import { ProfileCard } from "./ProfileCard";

const profile: MiraProfile = {
    avatar_url: "https://example.com/mira.png",
    comments_count: 5,
    description: "Personal AI operator.",
    display_name: "Mira",
    follower_count: 42,
    following_count: 7,
    karma: 123,
    name: "mira_2026",
    posts_count: 9,
};

describe("ProfileCard", () => {
    it("renders avatar, unread count, profile stats, and links", () => {
        render(<ProfileCard profile={profile} unreadCount={3} />);

        expect(screen.getByRole("img", { name: "mira_2026" })).toHaveAttribute(
            "src",
            "https://example.com/mira.png"
        );
        expect(screen.getByRole("link", { name: "Mira" })).toHaveAttribute(
            "href",
            "https://www.moltbook.com/u/mira_2026"
        );
        expect(screen.getByText("3 new")).toBeInTheDocument();
        expect(screen.getByText("Personal AI operator.")).toBeInTheDocument();
        expect(screen.getByText("123")).toBeInTheDocument();
        expect(screen.getByText("42")).toBeInTheDocument();
        expect(screen.getByText("7")).toBeInTheDocument();
    });

    it("falls back to the username and icon when display name/avatar are missing", () => {
        render(
            <ProfileCard
                profile={{ ...profile, avatar_url: null, display_name: "" }}
                unreadCount={0}
            />
        );

        expect(screen.getByRole("link", { name: "mira_2026" })).toBeInTheDocument();
        expect(screen.queryByText(/new/u)).not.toBeInTheDocument();
        expect(screen.queryByRole("img")).not.toBeInTheDocument();
    });
});
