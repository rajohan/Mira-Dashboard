import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LevelFilter } from "./LevelFilter";

describe("LevelFilter", () => {
    it("renders levels and toggles the selected level", () => {
        const onToggle = vi.fn();

        render(
            <LevelFilter
                levels={["info", "warn", "error"]}
                activeLevels={new Set(["warn"])}
                onToggle={onToggle}
            />
        );

        expect(screen.getByRole("button", { name: "info" })).toHaveClass(
            "bg-primary-700"
        );
        expect(screen.getByRole("button", { name: "warn" })).toHaveClass(
            "bg-yellow-500/20"
        );

        fireEvent.click(screen.getByRole("button", { name: "error" }));

        expect(onToggle).toHaveBeenCalledWith("error");
    });
});
