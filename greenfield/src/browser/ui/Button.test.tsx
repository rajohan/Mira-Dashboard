import { describe, expect, test } from "bun:test";

import { Save } from "lucide-react";

import { Button } from "./Button.tsx";
import type { ButtonVariant } from "./buttonStyles.ts";
import { Icon } from "./Icon.tsx";

const { render, screen } = await import("@testing-library/react");

const variants = Object.freeze([
    "danger",
    "ghost",
    "primary",
    "secondary",
] as const satisfies readonly ButtonVariant[]);

describe("Button", () => {
    test("uses the shared stable loading label for every busy variant", () => {
        render(
            <>
                {variants.map((variant) => (
                    <Button
                        busy
                        busyLabel={`Saving ${variant}…`}
                        key={variant}
                        variant={variant}
                    >
                        Save
                    </Button>
                ))}
            </>
        );

        for (const variant of variants) {
            const busyLabel = `Saving ${variant}…`;
            const button = screen.getByRole("button", { name: busyLabel });
            const visualLabel = button.querySelector("span[aria-hidden='true']");
            const dots = visualLabel?.querySelectorAll(".loading-state-dot");

            expect(button).toBeDisabled();
            expect(button).toHaveAttribute("aria-busy", "true");
            expect(button).toHaveAttribute("aria-label", busyLabel);
            expect(visualLabel).toHaveTextContent(`Saving ${variant}...`);
            expect(dots).toHaveLength(3);
            expect(button.querySelector("svg")).toHaveClass("motion-reduce:animate-none");
        }
    });

    test("preserves ordinary content and accessible naming when idle", () => {
        render(<Button aria-label="Save dashboard">Save</Button>);

        const button = screen.getByRole("button", { name: "Save dashboard" });

        expect(button).not.toBeDisabled();
        expect(button).not.toHaveAttribute("aria-busy");
        expect(button).toHaveTextContent("Save");
        expect(button.querySelector(".loading-state-dots")).toBeNull();
    });

    test("preserves a contextual action label while busy", () => {
        render(
            <Button aria-label="Revoke session on phone" busy busyLabel="Revoking…">
                Revoke
            </Button>
        );

        const button = screen.getByRole("button", {
            name: "Revoke session on phone",
        });

        expect(button).toBeDisabled();
        expect(button).toHaveAttribute("aria-busy", "true");
        expect(button).toHaveTextContent("Revoking...");
    });

    test("gives ghost icon actions a visible hover and active surface", () => {
        render(<Button variant="ghost">Close</Button>);

        expect(screen.getByRole("button", { name: "Close" })).toHaveClass(
            "data-hover:bg-primary-700",
            "data-active:bg-primary-600"
        );
    });

    test("keeps the secondary active state on a high-contrast surface", () => {
        render(<Button variant="secondary">Open edge panel</Button>);

        expect(screen.getByRole("button", { name: "Open edge panel" })).toHaveClass(
            "data-hover:bg-primary-600",
            "data-active:bg-primary-800"
        );
    });

    test("uses white content and inherited icon color for every filled variant", () => {
        render(
            <>
                {(["primary", "secondary", "danger"] as const).map((variant) => (
                    <Button key={variant} variant={variant}>
                        <Icon icon={Save} size="sm" />
                        Save {variant}
                    </Button>
                ))}
            </>
        );

        for (const variant of ["primary", "secondary", "danger"] as const) {
            const button = screen.getByRole("button", { name: `Save ${variant}` });
            expect(button).toHaveClass("text-white", "[&_svg]:text-inherit");
        }
    });
});
