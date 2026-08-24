import { describe, expect, test } from "bun:test";

import { LoadingState } from "./LoadingState.tsx";

const { render, screen } = await import("@testing-library/react");

function getVisibleLabel(status: HTMLElement): HTMLSpanElement {
    const label = status.querySelector(":scope > span[aria-hidden='true']");
    if (!(label instanceof HTMLSpanElement)) {
        throw new TypeError("LoadingState did not render its visual label");
    }
    return label;
}

describe("LoadingState", () => {
    test("keeps one stable accessible label while rendering animated visual dots", () => {
        render(<LoadingState label="Loading dashboard data…" />);

        const status = screen.getByRole("status", {
            name: "Loading dashboard data…",
        });
        const visibleLabel = getVisibleLabel(status);
        const dots = visibleLabel.querySelectorAll(".loading-state-dot");

        expect(status).toHaveAttribute("aria-busy", "true");
        expect(status).toHaveAttribute("aria-label", "Loading dashboard data…");
        expect(visibleLabel).toHaveAttribute("aria-hidden", "true");
        expect(visibleLabel).toHaveTextContent("Loading dashboard data...");
        expect(dots).toHaveLength(3);
        expect(Array.from(dots, (dot) => dot.textContent)).toEqual([".", ".", "."]);
        expect(status.querySelector("svg")).toHaveClass("motion-reduce:animate-none");
    });

    test("replaces existing dot suffixes without changing the accessible label", () => {
        const { rerender } = render(<LoadingState label="Refreshing..." />);

        let status = screen.getByRole("status", { name: "Refreshing..." });
        expect(getVisibleLabel(status)).toHaveTextContent("Refreshing...");

        rerender(<LoadingState label="Preparing" />);

        status = screen.getByRole("status", { name: "Preparing" });
        expect(getVisibleLabel(status)).toHaveTextContent("Preparing...");
    });
});
