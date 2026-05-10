import { render, screen } from "@testing-library/react";
import { Circle } from "lucide-react";
import { describe, expect, it } from "vitest";

import { MetricCard } from "./MetricCard";

describe("MetricCard", () => {
    it("renders metric value, subtitle, percent and capped bar", () => {
        const { container } = render(
            <MetricCard
                title="Coverage"
                value="90"
                subtitle="tests"
                percent={125}
                icon={<Circle data-testid="metric-icon" />}
            />
        );

        expect(screen.getByText("Coverage")).toBeInTheDocument();
        expect(screen.getByText("90")).toBeInTheDocument();
        expect(screen.getByText("tests")).toBeInTheDocument();
        expect(screen.getByText("125%")).toBeInTheDocument();
        expect(screen.getByTestId("metric-icon")).toBeInTheDocument();
        expect(container.querySelector("[style='width: 100%;']")).toBeInTheDocument();
    });

    it("supports subtitle-only and hidden percent label", () => {
        render(
            <MetricCard
                title="Queue"
                subtitle="No jobs"
                percent={42}
                showValue={false}
                showPercentLabel={false}
                color="purple"
            />
        );

        expect(screen.getByText("No jobs")).toHaveClass("text-sm");
        expect(screen.queryByText("42%")).not.toBeInTheDocument();
    });
});
