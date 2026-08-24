import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { TimePicker } from "./TimePicker.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function ControlledTimePicker({ error }: { readonly error?: string }) {
    const [value, setValue] = useState("05:30");
    return (
        <TimePicker
            error={error}
            label="Start time (24-hour)"
            onChange={setValue}
            value={value}
        />
    );
}

describe("TimePicker", () => {
    test("selects an explicit 24-hour hour and minute", async () => {
        render(<ControlledTimePicker />);
        const user = userEvent.setup();

        const hour = screen.getByRole("button", {
            name: "Start time (24-hour), hour",
        });
        const minute = screen.getByRole("button", {
            name: "Start time (24-hour), minute",
        });
        expect(hour).toHaveTextContent("05");
        expect(minute).toHaveTextContent("30");

        await user.click(hour);
        await user.click(screen.getByRole("option", { name: "23" }));
        await user.click(minute);
        await user.click(screen.getByRole("option", { name: "45" }));

        expect(hour).toHaveTextContent("23");
        expect(minute).toHaveTextContent("45");
    });

    test("associates one validation message with both segments", () => {
        render(<ControlledTimePicker error="Choose a future time." />);

        const error = screen.getByText("Choose a future time.");
        expect(
            screen
                .getByRole("group", { name: "Start time (24-hour)" })
                .getAttribute("aria-describedby")
                ?.split(" ")
        ).toContain(error.id);
        for (const name of [
            "Start time (24-hour), hour",
            "Start time (24-hour), minute",
        ]) {
            const segment = screen.getByRole("button", { name });
            expect(segment).toHaveAttribute("data-invalid");
        }
    });
});
