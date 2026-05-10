import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LiveFeedRow } from "./LiveFeedRow";

describe("LiveFeedRow", () => {
    it("renders session metadata, role, type, timestamp, and content", () => {
        render(
            <LiveFeedRow
                item={{
                    id: "1",
                    sessionLabel: "Dashboard",
                    sessionType: "direct",
                    role: "assistant",
                    content: "Rendered message",
                    timestamp: new Date(2026, 4, 10, 12, 0, 0).getTime(),
                }}
            />
        );

        expect(screen.getByText("Dashboard")).toBeInTheDocument();
        expect(screen.getByText("assistant")).toBeInTheDocument();
        expect(screen.getByText("direct")).toBeInTheDocument();
        expect(screen.getByText("12:00:00")).toBeInTheDocument();
        expect(screen.getByText("Rendered message")).toBeInTheDocument();
    });

    it("falls back to unknown session type and default role variant", () => {
        render(
            <LiveFeedRow
                item={{
                    id: "2",
                    sessionLabel: "Other",
                    sessionType: "",
                    role: "custom",
                    content: "Fallback message",
                    timestamp: 0,
                }}
            />
        );

        expect(screen.getByText("custom")).toBeInTheDocument();
        expect(screen.getByText("unknown")).toBeInTheDocument();
    });
});
