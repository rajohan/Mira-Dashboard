import { describe, expect, test } from "bun:test";

import { ProgressBar } from "./ProgressBar.tsx";

const { render, screen } = await import("@testing-library/react");

describe("ProgressBar", () => {
    test("exposes exact values while clamping the visual meter", () => {
        const { rerender } = render(
            <ProgressBar label="Token context used" maximum={272_000} value={40_000} />
        );

        const progress = screen.getByRole("progressbar", {
            name: "Token context used",
        });
        expect(progress).toHaveAttribute("aria-valuemin", "0");
        expect(progress).toHaveAttribute("aria-valuemax", "272000");
        expect(progress).toHaveAttribute("aria-valuenow", "40000");
        expect(progress.firstElementChild).toHaveClass("bg-emerald-500");
        expect(progress.firstElementChild).toHaveStyle({
            width: `${(40_000 / 272_000) * 100}%`,
        });

        rerender(
            <ProgressBar label="Over capacity" maximum={100} size="sm" value={140} />
        );
        const clamped = screen.getByRole("progressbar", { name: "Over capacity" });
        expect(clamped).toHaveClass("h-1.5");
        expect(clamped).toHaveAttribute("aria-valuenow", "100");
        expect(clamped.firstElementChild).toHaveClass("bg-red-500");
        expect(clamped.firstElementChild).toHaveStyle({ width: "100%" });
    });
});
