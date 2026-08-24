import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";

import { dashboardRoutePaths } from "../lib/dashboardRoutes.ts";
import { Route as terminalLazyRoute } from "../routes/terminal.lazy.tsx";
import { TerminalPageLayout } from "./TerminalRoute.tsx";

test("terminal route is authenticated, lazy registered, and parity-accounted", () => {
    expect(terminalLazyRoute.options.id).toBe("/terminal");
    expect(dashboardRoutePaths).toContain("/terminal");
});

test("terminal page removes the redundant intro and preserves a scrollable workspace", () => {
    const rendered = render(
        <TerminalPageLayout>
            <div aria-label="Terminal canvas fixture" className="h-full" />
        </TerminalPageLayout>
    );
    const layout = rendered.container.firstElementChild;
    const canvas = screen.getByLabelText("Terminal canvas fixture");

    expect(layout).not.toBeNull();
    expect(layout?.className.split(" ")).toEqual(
        expect.arrayContaining(["mx-auto", "w-full", "max-w-7xl", "min-h-full"])
    );
    expect(canvas.parentElement?.className.split(" ")).toEqual(
        expect.arrayContaining(["min-h-0", "flex-1", "flex-col"])
    );
    expect(screen.queryByText("Operations")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Terminal" })).toBeNull();
    expect(
        screen.queryByText(
            "Open an interactive terminal that starts in the folder you choose. The Dashboard does not save terminal input or output."
        )
    ).toBeNull();
});
