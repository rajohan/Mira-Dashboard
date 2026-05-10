import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveFeedRow } from "./LiveFeedRow";

function renderRow(item: Partial<React.ComponentProps<typeof LiveFeedRow>["item"]> = {}) {
    const defaultItem = {
        content: "Rendered message",
        id: "1",
        role: "assistant",
        sessionLabel: "Dashboard",
        sessionType: "direct",
        timestamp: new Date(2026, 4, 10, 12, 0, 0).getTime(),
    } satisfies React.ComponentProps<typeof LiveFeedRow>["item"];

    return render(<LiveFeedRow item={{ ...defaultItem, ...item }} />);
}

describe("LiveFeedRow", () => {
    it("renders session metadata, role, type, timestamp, and content", () => {
        renderRow();

        expect(screen.getByText("Dashboard")).toBeInTheDocument();
        expect(screen.getByText("assistant")).toBeInTheDocument();
        expect(screen.getByText("direct")).toBeInTheDocument();
        expect(screen.getByText("12:00:00")).toBeInTheDocument();
        expect(screen.getByText("Rendered message")).toBeInTheDocument();
    });

    it("falls back to unknown session type and default role variant", () => {
        renderRow({
            content: "Fallback message",
            id: "2",
            role: "custom",
            sessionLabel: "Other",
            sessionType: "",
            timestamp: 0,
        });

        expect(screen.getByText("custom")).toHaveClass("bg-primary-500/20");
        expect(screen.getByText("unknown")).toHaveClass("bg-primary-500/20");
        expect(screen.getByText("Fallback message")).toBeInTheDocument();
    });

    it.each([
        ["user", "bg-blue-500/20"],
        ["assistant", "bg-green-500/20"],
        ["system", "bg-yellow-500/20"],
        ["tool", "bg-green-500/20"],
        ["tool_result", "bg-green-500/20"],
        ["toolresult", "bg-green-500/20"],
    ])("maps %s role to the expected badge style", (role, expectedClass) => {
        renderRow({ role });

        expect(screen.getByText(role)).toHaveClass(expectedClass);
    });

    it.each([
        ["MAIN", "bg-blue-500/20"],
        ["HOOK", "bg-green-500/20"],
        ["CRON", "bg-purple-500/20"],
        ["SUBAGENT", "bg-orange-500/20"],
    ])(
        "maps %s session type to the expected badge style",
        (sessionType, expectedClass) => {
            renderRow({ sessionType });

            expect(screen.getByText(sessionType)).toHaveClass(expectedClass);
        }
    );

    it("preserves wrapped multiline content", () => {
        renderRow({ content: "first line\nsecond line" });

        const content = screen.getByText(/first line/u);
        expect(content).toHaveTextContent("first line second line");
        expect(content).toHaveClass("whitespace-pre-wrap");
    });
});
