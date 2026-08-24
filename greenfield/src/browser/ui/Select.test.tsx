import { describe, expect, test } from "bun:test";

import { useState } from "react";

import { Button } from "./Button.tsx";
import { FormField } from "./FormField.tsx";
import { Select } from "./Select.tsx";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;
const instrumentedInteractionTimeoutMs = 30_000;

const options = Object.freeze([
    { label: "Mira", value: "mira" },
    { label: "Raymond", value: "raymond" },
] as const);

function ControlledSelect() {
    const [value, setValue] = useState<(typeof options)[number]["value"]>("mira");

    return (
        <div>
            <Select
                ariaLabel="Task assignee"
                onChange={setValue}
                options={options}
                value={value}
            />
            <Button variant="secondary">Outside action</Button>
        </div>
    );
}

describe("Select", () => {
    test("uses an explicit accessible label for standalone filters", async () => {
        let selected: string | undefined;
        render(
            <Select
                ariaLabel="Task assignee"
                onChange={(value) => {
                    selected = value;
                }}
                options={options}
                value="mira"
            />
        );
        const user = userEvent.setup();

        await user.click(screen.getByRole("button", { name: "Task assignee" }));
        await user.click(screen.getByRole("option", { name: "Raymond" }));

        expect(selected).toBe("raymond");
        expect(screen.getByRole("button", { name: "Task assignee" })).toHaveClass(
            "w-full",
            "max-w-full",
            "min-w-0"
        );
        expect(
            screen.getByRole("button", { name: "Task assignee" }).querySelector("svg")
                ?.parentElement
        ).toHaveClass("hover:bg-primary-800", "active:bg-primary-700");
    });

    test("inherits its accessible name from a shared form field", () => {
        render(
            <FormField label="Assignee">
                <Select onChange={() => {}} options={options} value="mira" />
            </FormField>
        );

        expect(screen.getByRole("button", { name: "Assignee" })).toBeTruthy();
    });

    test("inherits disabled state from a shared form field", () => {
        render(
            <FormField disabled label="Assignee">
                <Select onChange={() => {}} options={options} value="mira" />
            </FormField>
        );

        expect(screen.getByRole("button", { name: "Assignee" })).toBeDisabled();
    });

    test(
        "supports repeated controlled selections after reopening",
        async () => {
            render(<ControlledSelect />);
            const user = userEvent.setup();
            const trigger = screen.getByRole("button", { name: "Task assignee" });

            await user.click(trigger);
            await user.click(screen.getByRole("option", { name: "Raymond" }));
            expect(trigger).toHaveTextContent("Raymond");

            await user.click(trigger);
            await user.click(screen.getByRole("option", { name: "Mira" }));
            expect(trigger).toHaveTextContent("Mira");
            await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
        },
        instrumentedInteractionTimeoutMs
    );

    test(
        "closes on outside click without making surrounding actions inert",
        async () => {
            render(<ControlledSelect />);
            const user = userEvent.setup();
            const trigger = screen.getByRole("button", { name: "Task assignee" });
            const outsideAction = screen.getByRole("button", {
                name: "Outside action",
            });

            await user.click(trigger);

            expect(screen.getByRole("listbox")).toBeTruthy();
            expect(outsideAction).not.toHaveAttribute("aria-hidden");
            expect(outsideAction.inert).toBe(false);
            await user.click(document.body);
            await waitFor(() => {
                expect(trigger).toHaveAttribute("aria-expanded", "false");
                expect(screen.queryByRole("listbox")).toBeNull();
            });
        },
        instrumentedInteractionTimeoutMs
    );
});
