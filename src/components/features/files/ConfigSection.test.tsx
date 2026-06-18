import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { ConfigSection } from "./ConfigSection";

describe("ConfigSection", () => {
    it("expands config groups and selects files", async () => {
        const user = userEvent.setup();
        const onSelect = jest.fn();

        render(<ConfigSection selectedPath="config:openclaw.json" onSelect={onSelect} />);

        expect(screen.getByText("openclaw.json")).toBeInTheDocument();
        expect(screen.queryByText("agentmail.ts")).not.toBeInTheDocument();

        const hooksButton = screen.getByRole("button", { name: "hooks" });
        const openclawButton = screen.getByRole("button", { name: "openclaw.json" });

        expect(hooksButton).toHaveAttribute("aria-expanded", "false");
        expect(openclawButton).toHaveAttribute("aria-current", "true");

        await user.click(hooksButton);
        expect(hooksButton).toHaveAttribute("aria-expanded", "true");
        await user.click(screen.getByRole("button", { name: "agentmail.ts" }));
        await user.click(openclawButton);

        expect(screen.getByText("transforms")).toBeInTheDocument();
        expect(onSelect).toHaveBeenNthCalledWith(
            1,
            "config:hooks/transforms/agentmail.ts"
        );
        expect(onSelect).toHaveBeenNthCalledWith(2, "config:openclaw.json");
    });

    it("supports keyboard activation for config groups and files", async () => {
        const user = userEvent.setup();
        const onSelect = jest.fn();

        render(<ConfigSection selectedPath={null} onSelect={onSelect} />);

        await user.tab();
        expect(screen.getByRole("button", { name: "hooks" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(screen.getByRole("button", { name: "hooks" })).toHaveAttribute(
            "aria-expanded",
            "true"
        );

        await user.tab();
        expect(screen.getByRole("button", { name: "agentmail.ts" })).toHaveFocus();
        await user.keyboard(" ");
        expect(onSelect).toHaveBeenCalledWith("config:hooks/transforms/agentmail.ts");
    });

    it("marks selected nested hook files", async () => {
        const user = userEvent.setup();
        const { rerender } = render(
            <ConfigSection selectedPath="config:openclaw.json" onSelect={jest.fn()} />
        );

        expect(screen.getByRole("button", { name: "openclaw.json" })).toHaveAttribute(
            "aria-current",
            "true"
        );

        rerender(
            <ConfigSection
                selectedPath="config:hooks/transforms/agentmail.ts"
                onSelect={jest.fn()}
            />
        );
        await user.click(screen.getByRole("button", { name: "hooks" }));
        expect(screen.getByRole("button", { name: "agentmail.ts" })).toHaveAttribute(
            "aria-current",
            "true"
        );
    });
});
