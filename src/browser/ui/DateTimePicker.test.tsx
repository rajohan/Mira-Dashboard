import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { DateTimePicker, type DateTimePickerValue } from "./DateTimePicker.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function ControlledDateTimePicker({ error }: { readonly error?: string }) {
    const [value, setValue] = useState<DateTimePickerValue>({
        date: new Date(2026, 7, 8, 12),
        time: "05:30",
    });
    return (
        <DateTimePicker
            error={error}
            label="Disabled until"
            onChange={setValue}
            value={value}
        />
    );
}

describe("DateTimePicker", () => {
    test("selects a localized date without changing the 24-hour time", async () => {
        render(<ControlledDateTimePicker />);
        const user = userEvent.setup();

        await user.click(
            screen.getByRole("button", {
                name: "Choose Disabled until date, selected 08.08.2026",
            })
        );
        const day = screen
            .getAllByRole("button")
            .find((button) => button.textContent?.trim() === "10");
        if (day === undefined) throw new Error("The August 10 calendar day is missing.");
        await user.click(day);

        expect(
            screen.getByRole("button", {
                name: "Choose Disabled until date, selected 10.08.2026",
            })
        ).toBeTruthy();
        expect(
            screen.getByRole("button", { name: "Time (24-hour), hour" })
        ).toHaveTextContent("05");
        expect(
            screen.getByRole("button", { name: "Time (24-hour), minute" })
        ).toHaveTextContent("30");
    });

    test("associates a combined validation message with every control", () => {
        render(<ControlledDateTimePicker error="Choose a future date and time." />);

        const error = screen.getByText("Choose a future date and time.");
        expect(
            screen
                .getByRole("group", { name: "Disabled until" })
                .getAttribute("aria-describedby")
                ?.split(" ")
        ).toContain(error.id);
        expect(
            screen
                .getByRole("group", { name: "Time (24-hour)" })
                .getAttribute("aria-describedby")
                ?.split(" ")
        ).toContain(error.id);
        expect(
            screen.getByRole("button", {
                name: "Choose Disabled until date, selected 08.08.2026",
            })
        ).toHaveAttribute("aria-invalid", "true");
    });
});
