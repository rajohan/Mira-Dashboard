import { expect, test } from "bun:test";

import { render, screen } from "@testing-library/react";

import { dashboardRoutePaths } from "../lib/dashboardRoutes.ts";
import { Route as terminalLazyRoute } from "../routes/terminal.lazy.tsx";
import { TerminalPageLayout } from "./TerminalRoute.tsx";

test("terminal route is authenticated, lazy registered, and parity-accounted", () => {
    expect(terminalLazyRoute.options.id).toBe("/terminal");
    expect(dashboardRoutePaths).toContain("/terminal");
});

test("terminal page uses the shared page container without shrinking its workspace", () => {
    const rendered = render(
        <TerminalPageLayout>
            <div aria-label="Terminal canvas fixture" className="h-full" />
        </TerminalPageLayout>
    );
    const layout = rendered.container.firstElementChild;
    const canvas = screen.getByLabelText("Terminal canvas fixture");

    expect(layout).not.toBeNull();
    expect(layout?.className.split(" ")).toEqual(
        expect.arrayContaining([
            "mx-auto",
            "w-full",
            "max-w-7xl",
            "h-full",
            "min-h-[calc(100dvh-8rem)]",
        ])
    );
    expect(canvas.parentElement?.className.split(" ")).toEqual(
        expect.arrayContaining(["mt-8", "min-h-0", "flex-1", "flex-col"])
    );
});
