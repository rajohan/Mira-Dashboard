import { describe, expect, test } from "bun:test";

import { Popover, PopoverContent, PopoverTrigger } from "./Popover.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

describe("Popover", () => {
    test("opens from the keyboard and restores trigger focus after Escape", async () => {
        render(
            <Popover>
                <PopoverTrigger aria-label="Open actions" variant="ghost">
                    Open
                </PopoverTrigger>
                <PopoverContent anchored={false} transition={false}>
                    <button type="button">Panel action</button>
                </PopoverContent>
            </Popover>
        );
        const user = userEvent.setup();
        const trigger = screen.getByRole("button", { name: "Open actions" });

        await user.tab();
        expect(trigger).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(screen.getByRole("button", { name: "Panel action" })).toBeTruthy();

        await user.keyboard("{Escape}");
        await waitFor(() => {
            expect(screen.queryByRole("button", { name: "Panel action" })).toBeNull();
            expect(trigger).toHaveFocus();
        });
    });
});
