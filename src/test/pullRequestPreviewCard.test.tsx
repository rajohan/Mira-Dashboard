import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "bun:test";

import { PullRequestPreviewCard } from "../components/features/pullRequests/PullRequestPreviewCard";
import type { PullRequestPreviewStatus } from "../hooks";

function preview(
    status: PullRequestPreviewStatus["status"],
    overrides: Partial<PullRequestPreviewStatus> = {}
): PullRequestPreviewStatus {
    return {
        commitSha: "a".repeat(40),
        number: 335,
        status,
        title: "Preview design",
        updatedAt: "2026-07-26T12:00:00.000Z",
        ...overrides,
    };
}

describe("PullRequestPreviewCard", () => {
    it("renders the available and unavailable preview states", () => {
        const { rerender } = render(<PullRequestPreviewCard preview={undefined} />);

        expect(screen.getByText("Available")).toBeInTheDocument();
        expect(
            screen.getByText("Run an eligible trusted PR in dev from its card below.")
        ).toBeInTheDocument();

        rerender(
            <PullRequestPreviewCard
                error={new Error("Preview status failed")}
                preview={undefined}
            />
        );

        expect(screen.getByText("Status unavailable")).toBeInTheDocument();
        expect(screen.getByText("Preview status failed")).toBeInTheDocument();
    });

    it("renders every managed lifecycle with bounded preview details", () => {
        const { rerender } = render(
            <PullRequestPreviewCard
                preview={preview("running", {
                    url: "https://preview.example:5173",
                })}
            />
        );

        expect(screen.getByText("Running")).toBeInTheDocument();
        expect(screen.getByText(/PR #335: Preview design/u)).toBeInTheDocument();
        expect(screen.getByText(/aaaaaaaa · Updated/u)).toBeInTheDocument();
        expect(screen.getByRole("link", { name: /Open dev/u })).toHaveAttribute(
            "href",
            "https://preview.example:5173"
        );

        rerender(<PullRequestPreviewCard preview={preview("starting")} />);
        expect(screen.getByText("Starting")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /Open dev/u })).not.toBeInTheDocument();

        rerender(<PullRequestPreviewCard preview={preview("stopping")} />);
        expect(screen.getByText("Stopping")).toBeInTheDocument();

        rerender(
            <PullRequestPreviewCard
                preview={preview("failed", {
                    commitSha: undefined,
                    message: "Preview worker failed",
                    title: "",
                    updatedAt: undefined,
                })}
            />
        );
        expect(screen.getByText("Failed")).toBeInTheDocument();
        expect(screen.getByText(/Untitled dev environment/u)).toBeInTheDocument();
        expect(screen.getByText("commit pending")).toBeInTheDocument();
        expect(screen.getByText("Preview worker failed")).toBeInTheDocument();

        rerender(<PullRequestPreviewCard preview={preview("stopped")} />);
        expect(screen.getByText("Available")).toBeInTheDocument();
    });
});
