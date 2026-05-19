import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { Skill } from "../../../types/settings";
import { SkillsSection } from "./SkillsSection";

const skills: Skill[] = [
    {
        description: "Browser automation helpers",
        enabled: true,
        name: "browser-automation",
        source: "builtin",
    },
    {
        description: "Local task tracking",
        enabled: false,
        name: "task-tracking",
        source: "workspace",
    },
    {
        description: undefined,
        enabled: false,
        name: "custom-skill",
        source: undefined,
    },
];

describe("SkillsSection", () => {
    it("filters skills and toggles a skill", async () => {
        const onToggle = vi.fn();
        render(<SkillsSection skills={skills} onToggle={onToggle} />);

        await userEvent.click(screen.getByRole("button", { name: /Skills/u }));
        expect(screen.getByText("1/3 enabled")).toBeInTheDocument();
        expect(screen.getByText("Browser automation helpers")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "all" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );

        await userEvent.click(screen.getByRole("button", { name: "enabled" }));
        expect(screen.getByRole("button", { name: "enabled" })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
        expect(screen.getByRole("button", { name: "all" })).toHaveAttribute(
            "aria-pressed",
            "false"
        );
        expect(screen.getByText("browser-automation")).toBeInTheDocument();
        expect(screen.queryByText("task-tracking")).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "disabled" }));
        expect(screen.queryByText("browser-automation")).not.toBeInTheDocument();
        expect(screen.getByText("task-tracking")).toBeInTheDocument();

        expect(screen.getByText("custom-skill")).toBeInTheDocument();
        expect(screen.getAllByText("Extra").length).toBeGreaterThan(0);

        await userEvent.click(screen.getByRole("button", { name: /Workspace/u }));
        expect(screen.getByRole("button", { name: /Workspace/u })).toHaveAttribute(
            "aria-pressed",
            "true"
        );
        expect(screen.getByRole("button", { name: /^All/u })).toHaveAttribute(
            "aria-pressed",
            "false"
        );
        expect(screen.queryByText("custom-skill")).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("switch"));
        expect(onToggle).toHaveBeenCalledWith("task-tracking", true);
    });

    it("shows empty filter state", async () => {
        render(<SkillsSection skills={skills} onToggle={vi.fn()} />);

        await userEvent.click(screen.getByRole("button", { name: /Skills/u }));
        await userEvent.type(screen.getByPlaceholderText("Search skills..."), "missing");

        expect(screen.getByText("No skills found")).toBeInTheDocument();
    });
});
