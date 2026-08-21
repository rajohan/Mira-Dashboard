import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { RadioGroup, type RadioGroupOption } from "./RadioGroup.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

type Channel = "beta" | "stable" | "unavailable";

const options = Object.freeze([
    {
        description: "Receives reviewed releases.",
        label: "Stable",
        value: "stable",
    },
    {
        description: "Receives release candidates.",
        label: "Beta",
        value: "beta",
    },
    {
        disabled: true,
        label: "Unavailable",
        value: "unavailable",
    },
] satisfies readonly RadioGroupOption<Channel>[]);

function ControlledRadioGroup({ invalid = false }: { readonly invalid?: boolean }) {
    const [value, setValue] = useState<Channel>("stable");
    return (
        <RadioGroup
            description="Choose the release stream for this worker."
            error={invalid ? "Choose an available release stream." : undefined}
            invalid={invalid}
            label="Release stream"
            onChange={setValue}
            options={options}
            orientation="horizontal"
            value={value}
        />
    );
}

describe("RadioGroup", () => {
    test("associates labels and descriptions and changes selection from the keyboard", async () => {
        render(<ControlledRadioGroup />);
        const user = userEvent.setup();
        const stable = screen.getByRole("radio", { name: "Stable" });

        expect(
            screen.getByRole("radiogroup", { name: "Release stream" })
        ).toHaveAttribute("aria-orientation", "horizontal");
        expect(stable).toBeChecked();
        expect(stable).toHaveAccessibleDescription("Receives reviewed releases.");
        expect(screen.getByText("Receives reviewed releases.")).toHaveClass(
            "group-data-checked:text-primary-300"
        );

        await user.tab();
        expect(stable).toHaveFocus();
        await user.keyboard("{ArrowRight}");

        expect(screen.getByRole("radio", { name: "Beta" })).toBeChecked();
        expect(screen.getByRole("radio", { name: "Unavailable" })).toHaveAttribute(
            "aria-disabled",
            "true"
        );
    });

    test("exposes invalid state without allowing the option cards to overflow", () => {
        render(<ControlledRadioGroup invalid />);
        const group = screen.getByRole("radiogroup", { name: "Release stream" });
        const stable = screen.getByRole("radio", { name: "Stable" });

        expect(group).toHaveAttribute("aria-invalid", "true");
        expect(group).toHaveAccessibleDescription(
            "Choose the release stream for this worker. Choose an available release stream."
        );
        expect(stable).toHaveClass(
            "size-full",
            "max-w-full",
            "min-w-0",
            "border-red-500"
        );
    });
});
