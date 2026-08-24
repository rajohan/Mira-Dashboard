import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { Combobox, type ComboboxOption } from "./Combobox.tsx";
import { FormField } from "./FormField.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

type TimeZone = "America/New_York" | "Europe/Oslo" | "UTC";

const options = Object.freeze([
    { label: "UTC", value: "UTC" },
    {
        description: "Norway",
        keywords: ["Norway", "CET"],
        label: "Europe/Oslo",
        value: "Europe/Oslo",
    },
    { disabled: true, label: "America/New_York", value: "America/New_York" },
] satisfies readonly ComboboxOption<TimeZone>[]);

function ControlledTimeZoneCombobox({
    disabled = false,
    error,
}: {
    readonly disabled?: boolean;
    readonly error?: string;
}) {
    const [value, setValue] = useState<TimeZone>("UTC");
    return (
        <FormField
            description="UTC or a canonical IANA zone."
            disabled={disabled}
            error={error}
            label="Time zone"
        >
            <Combobox
                ariaLabel="Time zone"
                className="mt-2"
                name="timeZone"
                onChange={setValue}
                options={options}
                value={value}
            />
        </FormField>
    );
}

describe("Combobox", () => {
    test("filters searchable metadata and selects one strict option", async () => {
        render(<ControlledTimeZoneCombobox />);
        const user = userEvent.setup();
        const input = screen.getByRole("combobox", { name: "Time zone" });

        expect(input).toHaveValue("UTC");
        expect(input).toHaveAccessibleDescription("UTC or a canonical IANA zone.");
        expect(screen.getByRole("button", { name: "Open Time zone" })).toBeEnabled();
        await user.clear(input);
        await user.type(input, "norway");

        const oslo = await screen.findByRole("option", { name: /Europe\/Oslo/u });
        expect(oslo).toHaveClass("w-full", "data-selected:bg-accent-500/15");
        expect(screen.queryByRole("option", { name: "UTC" })).toBeNull();
        await user.click(oslo);

        expect(input).toHaveValue("Europe/Oslo");
        expect(document.querySelector("input[name='timeZone']")).toHaveValue(
            "Europe/Oslo"
        );
        await user.click(screen.getByRole("button", { name: "Open Time zone" }));
        expect(
            await screen.findByRole("option", { name: "America/New_York" })
        ).toHaveAttribute("aria-disabled", "true");
    });

    test("shows an empty result and inherits field validation", async () => {
        render(<ControlledTimeZoneCombobox error="Choose a canonical time zone." />);
        const user = userEvent.setup();
        const input = screen.getByRole("combobox", { name: "Time zone" });

        expect(input).toHaveAttribute("data-invalid");
        expect(input).toHaveAccessibleDescription(
            "UTC or a canonical IANA zone. Choose a canonical time zone."
        );
        await user.clear(input);
        await user.type(input, "not-a-zone");

        expect(
            await screen.findByRole("option", { name: "No matching options" })
        ).toHaveAttribute("aria-disabled", "true");
    });

    test("inherits disabled state from its owning field", () => {
        render(<ControlledTimeZoneCombobox disabled />);

        expect(screen.getByRole("combobox", { name: "Time zone" })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Open Time zone" })).toBeDisabled();
    });
});
