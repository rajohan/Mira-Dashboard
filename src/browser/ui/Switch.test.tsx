import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { Switch } from "./Switch.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

function ControlledSwitch() {
    const [checked, setChecked] = useState(false);
    return (
        <Switch
            checked={checked}
            description="Send one alert when the worker stops reporting."
            label="Worker alerts"
            name="workerAlerts"
            onChange={setChecked}
            value="enabled"
        />
    );
}

function failDisabledSwitchChange(): never {
    throw new Error("Disabled switch changed");
}

describe("Switch", () => {
    test("is labelled, described, form-compatible, and keyboard operable", async () => {
        render(<ControlledSwitch />);
        const user = userEvent.setup();
        const control = screen.getByRole("switch", { name: "Worker alerts" });

        expect(control).not.toBeChecked();
        expect(control).toHaveAccessibleDescription(
            "Send one alert when the worker stops reporting."
        );
        expect(document.querySelector('input[name="workerAlerts"]')).not.toBeNull();

        await user.tab();
        expect(control).toHaveFocus();
        await user.keyboard(" ");

        expect(control).toBeChecked();
    });

    test("renders disabled and invalid states without shrinking its label", () => {
        render(
            <Switch
                checked={false}
                disabled
                error="Resolve the worker configuration first."
                label="A deliberately long worker alert label"
                onChange={failDisabledSwitchChange}
            />
        );
        const control = screen.getByRole("switch", {
            name: "A deliberately long worker alert label",
        });

        expect(control).toBeDisabled();
        expect(control).toHaveAttribute("aria-invalid", "true");
        expect(control).toHaveAccessibleDescription(
            "Resolve the worker configuration first."
        );
        expect(control).toHaveClass("shrink-0", "border-red-500");
        expect(control.parentElement).toHaveClass("min-w-0", "max-w-full");
    });
});
