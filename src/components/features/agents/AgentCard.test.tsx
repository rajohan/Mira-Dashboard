import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { AgentCard } from "./AgentCard";

vi.mock("../../../utils/format", async (importOriginal) => {
    const actual = await importOriginal<typeof import("../../../utils/format")>();
    return {
        ...actual,
        formatDuration: vi.fn(() => "2m ago"),
    };
});

describe("AgentCard", () => {
    it("renders active task, activity, channel, status and shortened model", () => {
        render(
            <AgentCard
                id="main"
                status="thinking"
                model="openai-codex/gpt-5.5"
                currentTask="Writing tests"
                currentActivity="Running vitest"
                lastActivity="2026-05-10T10:00:00.000Z"
                channel="webchat"
            />
        );

        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("gpt-5.5")).toBeInTheDocument();
        expect(screen.getByText("Thinking")).toBeInTheDocument();
        expect(screen.getByText("Writing tests")).toBeInTheDocument();
        expect(screen.getByText("Running vitest")).toBeInTheDocument();
        expect(screen.getByText("webchat")).toBeInTheDocument();
        expect(screen.getByText(/Last active 2m ago/)).toBeInTheDocument();
    });

    it("renders empty state and missing last activity fallback", () => {
        render(
            <AgentCard
                id="ops"
                status="idle"
                model="glm51"
                currentTask={null}
                currentActivity={null}
                lastActivity={null}
                channel={null}
            />
        );

        expect(screen.getByText("Ready")).toBeInTheDocument();
        expect(screen.getByText("No active task")).toBeInTheDocument();
        expect(screen.getByText(/Last active N\/A/)).toBeInTheDocument();
    });
});
