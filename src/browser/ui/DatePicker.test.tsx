import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { DatePicker } from "./DatePicker.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const fixtureNow = new Date();

// Noon on the given day of the current month, so the fixture never depends on a hardcoded month.
function fixtureDate(dayOfMonth: number): Date {
    return new Date(fixtureNow.getFullYear(), fixtureNow.getMonth(), dayOfMonth, 12);
}

function formattedFixtureDate(date: Date): string {
    return [
        date.getDate().toString().padStart(2, "0"),
        (date.getMonth() + 1).toString().padStart(2, "0"),
        date.getFullYear().toString(),
    ].join(".");
}

const initialDateLabel = `Choose Maintenance date, selected ${formattedFixtureDate(fixtureDate(8))}`;
const selectedDateLabel = `Choose Maintenance date, selected ${formattedFixtureDate(fixtureDate(10))}`;

function ControlledDatePicker({ error }: { readonly error?: string }) {
    const [value, setValue] = useState(fixtureDate(8));
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
                name: initialDateLabel,
            })
        );
        const day = screen
            .getAllByRole("button")
            .find((button) => button.textContent?.trim() === "10");
        if (day === undefined) throw new Error("The 10th calendar day is missing.");
        await user.click(day);

        expect(
            screen.getByRole("button", {
                name: selectedDateLabel,
            })
        ).toBeTruthy();
    });

    test("associates validation with the date group and trigger", () => {
        render(<ControlledDatePicker error="Choose a future date." />);

        const error = screen.getByText("Choose a future date.");
        const group = screen.getByRole("group", { name: "Maintenance date" });
        const trigger = screen.getByRole("button", {
            name: initialDateLabel,
        });
        expect(group.getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
        expect(trigger).toHaveAttribute("aria-invalid", "true");
        expect(trigger).toHaveAttribute("data-invalid");
    });
});
