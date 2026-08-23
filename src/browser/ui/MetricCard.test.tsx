import { describe, expect, test } from "bun:test";

import { Cpu } from "lucide-react";

import { MetricCard } from "./MetricCard.tsx";

const { render, screen } = await import("@testing-library/react");

describe("MetricCard", () => {
    test("labels its value and clamps only the visual meter", () => {
        render(
            <MetricCard
                description="1 minute normalized load"
                icon={Cpu}
                meter={{ label: "CPU normalized load", maximum: 100, value: 248.1 }}
                title="CPU"
                value="248.1%"
            />
        );

        expect(screen.getByRole("heading", { level: 3, name: "CPU" })).toBeTruthy();
        expect(screen.getByText("248.1%")).toBeTruthy();
        expect(
            screen.getByRole("progressbar", { name: "CPU normalized load" })
        ).toHaveValue(100);
    });

    test("offers compact spacing without changing the text-left icon-right layout", () => {
        render(
            <MetricCard
                compact
                description="Host uptime"
                icon={Cpu}
                title="Uptime"
                value="2d 3h"
            />
        );

        const card = screen.getByRole("heading", { name: "Uptime" }).closest("section");
        expect(card).toHaveClass("p-4");
        expect(card?.firstElementChild).toHaveClass("justify-between");
        expect(screen.getByText("2d 3h")).toHaveClass("text-xl");
    });

    test("places a compact summary on the left and its percentage on the right", () => {
        render(
            <MetricCard
                compact
                compactSummary
                description="2.74, 3.68, 3.05"
                icon={Cpu}
                meter={{ label: "CPU load", maximum: 100, value: 69 }}
                title="CPU"
                value="69%"
            />
        );

        const summary = screen.getByText("2.74, 3.68, 3.05");
        const percentage = screen.getByText("69%");
        expect(summary.parentElement).toBe(percentage.parentElement);
        expect(summary.parentElement).toHaveClass("justify-between");
    });
});
