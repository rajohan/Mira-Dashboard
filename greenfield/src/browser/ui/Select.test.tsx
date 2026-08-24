import { describe, expect, test } from "bun:test";

import { FormField } from "./FormField.tsx";
import { Select } from "./Select.tsx";

const { render, screen } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const options = Object.freeze([
    { label: "Mira", value: "mira" },
    { label: "Raymond", value: "raymond" },
] as const);

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
});
