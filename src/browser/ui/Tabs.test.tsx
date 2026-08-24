import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { Tabs, type TabDefinition } from "./Tabs.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

type JobView = "history" | "overview" | "unavailable";

const tabs = Object.freeze([
    { label: "Overview", panel: <p>Current worker state</p>, value: "overview" },
    { label: "History", panel: <p>Recent worker runs</p>, value: "history" },
    {
        disabled: true,
        label: "Unavailable",
        panel: <p>Unavailable diagnostics</p>,
        value: "unavailable",
    },
] satisfies readonly TabDefinition<JobView>[]);

function ControlledTabs({ vertical = false }: { readonly vertical?: boolean }) {
    const [value, setValue] = useState<JobView>("overview");
    return (
        <Tabs
            ariaLabel="Worker details"
            description="Choose one worker detail view."
            onChange={setValue}
            tabs={tabs}
            value={value}
            vertical={vertical}
        />
    );
}

describe("Tabs", () => {
    test("links tabs to panels and follows keyboard selection while skipping disabled tabs", async () => {
        render(<ControlledTabs />);
        const user = userEvent.setup();
        const overview = screen.getByRole("tab", { name: "Overview" });

        expect(
            screen.getByRole("tablist", { name: "Worker details" })
        ).toHaveAccessibleDescription("Choose one worker detail view.");
        expect(overview).toHaveAttribute("aria-selected", "true");
        expect(overview).toHaveClass(
            "not-data-selected:not-data-disabled:data-hover:bg-primary-800",
            "hover:not-data-selected:not-data-disabled:bg-primary-800",
            "data-selected:bg-accent-700",
            "data-selected:text-white",
            "[&_svg]:text-inherit"
        );
        expect(screen.getByRole("tabpanel")).toHaveTextContent("Current worker state");

        await user.tab();
        expect(overview).toHaveFocus();
        await user.keyboard("{ArrowRight}");

        expect(screen.getByRole("tab", { name: "History" })).toHaveAttribute(
            "aria-selected",
            "true"
        );
        expect(screen.getByRole("tabpanel")).toHaveTextContent("Recent worker runs");
        expect(screen.getByRole("tab", { name: "Unavailable" })).toBeDisabled();
    });

    test("wraps horizontal tabs without page overflow and supports a responsive vertical layout", () => {
        const { unmount } = render(<ControlledTabs />);
        expect(screen.getByRole("tablist", { name: "Worker details" })).toHaveClass(
            "min-w-0",
            "max-w-full",
            "flex-wrap"
        );
        expect(screen.getByRole("tab", { name: "Overview" })).toHaveClass(
            "basis-28",
            "grow",
            "min-w-0"
        );
        unmount();

        render(<ControlledTabs vertical />);
        expect(screen.getByRole("tablist", { name: "Worker details" })).toHaveAttribute(
            "aria-orientation",
            "vertical"
        );
        expect(screen.getByRole("tab", { name: "Overview" })).toHaveClass(
            "w-full",
            "max-w-full"
        );
    });
});
