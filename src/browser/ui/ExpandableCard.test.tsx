import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { Badge } from "./Badge.tsx";
import { Button } from "./Button.tsx";
import { ExpandableCard } from "./ExpandableCard.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function ControlledCompactCard() {
    const [open, setOpen] = useState(false);
    return (
        <ExpandableCard
            compact
            onOpenChange={setOpen}
            open={open}
            title="Background task"
            trailing={<Badge variant="default">Running</Badge>}
        >
            {(_open, close) => (
                <div>
                    <p>Exact task details</p>
                    <Button onClick={close} size="sm" variant="ghost">
                        Close task details
                    </Button>
                </div>
            )}
        </ExpandableCard>
    );
}

describe("ExpandableCard", () => {
    test("supports a compact controlled disclosure and restores trigger focus", async () => {
        const user = userEvent.setup();
        render(<ControlledCompactCard />);

        await user.click(screen.getByRole("button", { name: "Background task Running" }));
        const openedTrigger = screen.getByRole("button", {
            name: "Background task Running",
        });
        expect(openedTrigger).toHaveAttribute("aria-expanded", "true");
        expect(openedTrigger).toHaveFocus();
        expect(screen.getByText("Exact task details")).toBeVisible();

        await user.click(screen.getByRole("button", { name: "Close task details" }));
        await waitFor(() =>
            expect(screen.queryByText("Exact task details")).not.toBeInTheDocument()
        );
        const closedTrigger = screen.getByRole("button", {
            name: "Background task Running",
        });
        expect(closedTrigger).toHaveAttribute("aria-expanded", "false");
        expect(closedTrigger).toHaveFocus();
    });

    test("keeps controlled disclosure state synchronized for keyboard toggles", async () => {
        const user = userEvent.setup();
        render(<ControlledCompactCard />);

        const closedTrigger = screen.getByRole("button", {
            name: "Background task Running",
        });
        await user.tab();
        expect(closedTrigger).toHaveFocus();
        await user.keyboard("{Enter}");

        const openedTrigger = screen.getByRole("button", {
            name: "Background task Running",
        });
        expect(openedTrigger).toHaveAttribute("aria-expanded", "true");
        expect(openedTrigger).toHaveFocus();
        expect(screen.getByText("Exact task details")).toBeVisible();

        await user.keyboard(" ");
        await waitFor(() =>
            expect(screen.queryByText("Exact task details")).not.toBeInTheDocument()
        );
        const reclosedTrigger = screen.getByRole("button", {
            name: "Background task Running",
        });
        expect(reclosedTrigger).toHaveAttribute("aria-expanded", "false");
        expect(reclosedTrigger).toHaveFocus();
    });
});
