import { describe, expect, test } from "bun:test";

import { Fieldset } from "./Fieldset.tsx";
import { Input } from "./Input.tsx";

const { render, screen } = await import("@testing-library/react");

describe("Fieldset", () => {
    test("associates shared descriptions and exposes invalid state to children", () => {
        render(
            <>
                <p id="outside-description">Required for scheduled delivery.</p>
                <Fieldset
                    ariaDescribedBy="outside-description"
                    description="Use local Oslo time."
                    error="Choose a valid window."
                    legend="Delivery window"
                >
                    {({ describedBy }) => (
                        <div>
                            <input
                                aria-describedby={describedBy}
                                aria-label="Window name"
                            />
                            <Input aria-label="Inherited invalid state" />
                        </div>
                    )}
                </Fieldset>
            </>
        );

        const group = screen.getByRole("group", { name: "Delivery window" });
        const input = screen.getByRole("textbox", { name: "Window name" });

        expect(group).toHaveAttribute("aria-invalid", "true");
        expect(group).toHaveAttribute("data-invalid");
        expect(group.getAttribute("aria-describedby")?.split(" ")).toHaveLength(3);
        expect(input).toHaveAccessibleDescription(
            "Required for scheduled delivery. Use local Oslo time. Choose a valid window."
        );
        expect(
            screen.getByRole("textbox", { name: "Inherited invalid state" })
        ).toHaveAttribute("data-invalid");
    });

    test("disables descendant controls through the native fieldset", () => {
        render(
            <Fieldset disabled legend="Locked settings">
                <Input aria-label="Locked value" />
            </Fieldset>
        );

        expect(screen.getByRole("group", { name: "Locked settings" })).toHaveAttribute(
            "data-disabled"
        );
        expect(screen.getByRole("textbox", { name: "Locked value" })).toBeDisabled();
    });
});
