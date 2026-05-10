import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { SessionStatsBar } from "./SessionStatsBar";

vi.mock("../../../utils/format", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../utils/format")>();
    return {
        ...actual,
        formatDuration: vi.fn(() => "5 minutes ago"),
    };
});

describe("SessionStatsBar", () => {
    it("renders model, token usage, progress, and last active text", () => {
        render(
            <SessionStatsBar
                model="openai-codex/gpt-5.5"
                tokenCount={50_000}
                maxTokens={200_000}
                updatedAt={new Date("2026-05-10T10:00:00.000Z").getTime()}
            />
        );

        expect(screen.getByText("Model")).toBeInTheDocument();
        expect(screen.getByText("openai-codex/gpt-5.5")).toBeInTheDocument();
        expect(screen.getByText("Tokens")).toBeInTheDocument();
        expect(screen.getByText("50.0k / 200k")).toBeInTheDocument();
        expect(screen.getByText("Last Active")).toBeInTheDocument();
        expect(screen.getByText("5 minutes ago")).toBeInTheDocument();
    });
});
