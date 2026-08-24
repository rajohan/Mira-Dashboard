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
});
