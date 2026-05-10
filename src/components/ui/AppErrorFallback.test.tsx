import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { AppErrorFallback } from "./AppErrorFallback";

describe("AppErrorFallback", () => {
    it("renders error messages and resets the boundary", async () => {
        const resetErrorBoundary = vi.fn();
        render(
            <AppErrorFallback
                error={new Error("Boom")}
                resetErrorBoundary={resetErrorBoundary}
            />
        );

        expect(
            screen.getByText("Something went wrong in the dashboard")
        ).toBeInTheDocument();
        expect(screen.getByText("Boom")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Try again" }));

        expect(resetErrorBoundary).toHaveBeenCalledTimes(1);
    });

    it("triggers a full page reload", async () => {
        const reload = vi.fn();
        const originalLocation = window.location;
        Object.defineProperty(window, "location", {
            configurable: true,
            value: { reload },
        });

        try {
            render(
                <AppErrorFallback
                    error={new Error("Boom")}
                    resetErrorBoundary={vi.fn()}
                />
            );

            await userEvent.click(screen.getByRole("button", { name: "Full reload" }));
            expect(reload).toHaveBeenCalledTimes(1);
        } finally {
            Object.defineProperty(window, "location", {
                configurable: true,
                value: originalLocation,
            });
        }
    });

    it("falls back for non-Error values", () => {
        render(<AppErrorFallback error="bad" resetErrorBoundary={vi.fn()} />);

        expect(screen.getByText("Unknown error")).toBeInTheDocument();
    });
});
