import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { DatePicker } from "./DatePicker.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function ControlledDatePicker({ error }: { readonly error?: string }) {
    const [value, setValue] = useState(new Date(2026, 7, 8, 12));
    return (
        <DatePicker
            error={error}
            label="Maintenance date"
            onChange={setValue}
            value={value}
        />
    );
}

describe("DatePicker", () => {
    test("selects a Norwegian-formatted calendar date", async () => {
        render(<ControlledDatePicker />);
        const user = userEvent.setup();

        await user.click(
            screen.getByRole("button", {
                name: "Choose Maintenance date, selected 08.08.2026",
            })
        );
        const day = screen
            .getAllByRole("button")
            .find((button) => button.textContent?.trim() === "10");
        if (day === undefined) throw new Error("The August 10 calendar day is missing.");
        await user.click(day);

        expect(
            screen.getByRole("button", {
                name: "Choose Maintenance date, selected 10.08.2026",
            })
        ).toBeTruthy();
    });

    test("associates validation with the date group and trigger", () => {
        render(<ControlledDatePicker error="Choose a future date." />);

        const error = screen.getByText("Choose a future date.");
        const group = screen.getByRole("group", { name: "Maintenance date" });
        const trigger = screen.getByRole("button", {
            name: "Choose Maintenance date, selected 08.08.2026",
        });
        expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
        expect(trigger).toHaveAttribute("aria-invalid", "true");
        expect(trigger).toHaveAttribute("data-invalid");
    });
});
