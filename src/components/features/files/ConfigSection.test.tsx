import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfigSection } from "./ConfigSection";

describe("ConfigSection", () => {
    it("expands config groups and selects files", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();

        render(<ConfigSection selectedPath="config:openclaw.json" onSelect={onSelect} />);

        expect(screen.getByText("openclaw.json")).toBeInTheDocument();
        expect(screen.queryByText("jobs.json")).not.toBeInTheDocument();
        expect(screen.queryByText("agentmail.ts")).not.toBeInTheDocument();

        const cronButton = screen.getByRole("button", { name: "cron" });
        const hooksButton = screen.getByRole("button", { name: "hooks" });
        const openclawButton = screen.getByRole("button", { name: "openclaw.json" });

        expect(cronButton).toHaveAttribute("aria-expanded", "false");
        expect(hooksButton).toHaveAttribute("aria-expanded", "false");
        expect(openclawButton).toHaveAttribute("aria-current", "true");

        await user.click(cronButton);
        expect(cronButton).toHaveAttribute("aria-expanded", "true");
        await user.click(screen.getByRole("button", { name: "jobs.json" }));

        await user.click(hooksButton);
        expect(hooksButton).toHaveAttribute("aria-expanded", "true");
        await user.click(screen.getByRole("button", { name: "agentmail.ts" }));
        await user.click(openclawButton);

        expect(screen.getByText("transforms")).toBeInTheDocument();
        expect(onSelect).toHaveBeenNthCalledWith(1, "config:cron/jobs.json");
        expect(onSelect).toHaveBeenNthCalledWith(
            2,
            "config:hooks/transforms/agentmail.ts"
        );
        expect(onSelect).toHaveBeenNthCalledWith(3, "config:openclaw.json");
    });

    it("supports keyboard activation for config groups and files", async () => {
        const user = userEvent.setup();
        const onSelect = vi.fn();

        render(<ConfigSection selectedPath={null} onSelect={onSelect} />);

        await user.tab();
        expect(screen.getByRole("button", { name: "cron" })).toHaveFocus();
        await user.keyboard("{Enter}");
        expect(screen.getByRole("button", { name: "cron" })).toHaveAttribute(
            "aria-expanded",
            "true"
        );

        await user.tab();
        expect(screen.getByRole("button", { name: "jobs.json" })).toHaveFocus();
        await user.keyboard(" ");
        expect(onSelect).toHaveBeenCalledWith("config:cron/jobs.json");
    });
});
