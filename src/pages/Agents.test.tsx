import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Agents } from "./Agents";

const hooks = vi.hoisted(() => ({
    useAgentsStatus: vi.fn(),
}));

vi.mock("../hooks/useAgents", () => ({
    useAgentsStatus: hooks.useAgentsStatus,
}));

vi.mock("../components/features/agents/AgentCard", () => ({
    AgentCard: ({ id, status }: { id: string; status: string }) => (
        <article data-testid="agent-card">
            {id}: {status}
        </article>
    ),
}));

vi.mock("../components/features/agents/TaskHistorySidebar", () => ({
    TaskHistorySidebar: () => <aside data-testid="task-history">Task history</aside>,
}));

describe("Agents page", () => {
    beforeEach(() => {
        hooks.useAgentsStatus.mockReset();
    });

    it("renders loading state with task history sidebar", () => {
        hooks.useAgentsStatus.mockReturnValue({
            data: undefined,
            error: null,
            isLoading: true,
        });

        render(<Agents />);

        expect(screen.getByText("Loading agents...")).toBeInTheDocument();
        expect(screen.getByTestId("task-history")).toBeInTheDocument();
    });

    it("renders errors while keeping the agent list area", () => {
        hooks.useAgentsStatus.mockReturnValue({
            data: { agents: [] },
            error: new Error("Gateway unavailable"),
            isLoading: false,
        });

        render(<Agents />);

        expect(screen.getByText("Gateway unavailable")).toBeInTheDocument();
        expect(screen.getByText(/No agents configured/)).toBeInTheDocument();
    });

    it("groups active, idle, and offline agents", () => {
        hooks.useAgentsStatus.mockReturnValue({
            data: {
                agents: [
                    { id: "main", status: "active" },
                    { id: "coder", status: "thinking" },
                    { id: "monitor", status: "idle" },
                    { id: "researcher", status: "offline" },
                ],
            },
            error: null,
            isLoading: false,
        });

        render(<Agents />);

        expect(screen.getByText("Active (2)")).toBeInTheDocument();
        expect(screen.getByText("Idle (1)")).toBeInTheDocument();
        expect(screen.getByText("Offline (1)")).toBeInTheDocument();
        expect(screen.getAllByTestId("agent-card")).toHaveLength(4);
        expect(screen.getByText("main: active")).toBeInTheDocument();
        expect(screen.getByText("coder: thinking")).toBeInTheDocument();
        expect(screen.getByText("monitor: idle")).toBeInTheDocument();
        expect(screen.getByText("researcher: offline")).toBeInTheDocument();
    });

    it("renders empty state when no agents are configured", () => {
        hooks.useAgentsStatus.mockReturnValue({
            data: { agents: [] },
            error: null,
            isLoading: false,
        });

        render(<Agents />);

        expect(screen.getByText(/No agents configured/)).toBeInTheDocument();
        expect(screen.getByText("~/.openclaw/openclaw.json")).toBeInTheDocument();
    });
});
