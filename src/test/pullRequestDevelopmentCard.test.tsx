import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, jest } from "bun:test";

import { PullRequestDevelopmentCard } from "../components/features/delivery/PullRequestDevelopmentCard";
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

describe("PullRequestDevelopmentCard", () => {
    it("renders the available and unavailable preview states", () => {
        const { rerender } = render(<PullRequestDevelopmentCard preview={undefined} />);

        expect(screen.getByText("Available")).toBeInTheDocument();
        expect(screen.getByText(/fixed PR commit/u)).toBeInTheDocument();
        expect(screen.queryByText(/hot reload/iu)).not.toBeInTheDocument();
        expect(
            screen.getByText("Run an eligible trusted PR in dev from its card below.")
        ).toBeInTheDocument();

        rerender(
            <PullRequestDevelopmentCard
                error={new Error("Preview status failed")}
                preview={undefined}
            />
        );

        expect(screen.getByText("Status unavailable")).toBeInTheDocument();
        expect(screen.getByText("Preview status failed")).toBeInTheDocument();

        rerender(
            <PullRequestDevelopmentCard
                preview={{
                    controlsAvailable: false,
                    message:
                        "PR dev controls are available only from the production Dashboard.",
                    status: "stopped",
                }}
            />
        );

        expect(screen.getByText("View only")).toBeInTheDocument();
        expect(
            screen.getByText(
                "PR dev controls are available only from the production Dashboard."
            )
        ).toBeInTheDocument();
    });

    it("renders every managed lifecycle with bounded preview details", () => {
        const onStop = jest.fn();
        const { rerender } = render(
            <PullRequestDevelopmentCard
                onStop={onStop}
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
        fireEvent.click(screen.getByRole("button", { name: "Stop dev" }));
        expect(onStop).toHaveBeenCalledTimes(1);

        rerender(
            <PullRequestDevelopmentCard onStop={onStop} preview={preview("starting")} />
        );
        expect(screen.getByText("Starting")).toBeInTheDocument();
        expect(screen.queryByRole("link", { name: /Open dev/u })).not.toBeInTheDocument();

        rerender(
            <PullRequestDevelopmentCard onStop={onStop} preview={preview("stopping")} />
        );
        expect(screen.getByText("Stopping")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Stop dev" })).toBeDisabled();

        rerender(
            <PullRequestDevelopmentCard
                onStop={onStop}
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

        rerender(
            <PullRequestDevelopmentCard onStop={onStop} preview={preview("stopped")} />
        );
        expect(screen.getByText("Available")).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Stop dev" })).toBeNull();
    });
});
