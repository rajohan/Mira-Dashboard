import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { TaskHistorySidebar } from "./TaskHistorySidebar";

const useAgentTaskHistoryMock = vi.fn();

vi.mock("../../../hooks/useAgents", () => ({
    useAgentTaskHistory: (limit: number) => useAgentTaskHistoryMock(limit),
}));

describe("TaskHistorySidebar", () => {
    it("requests recent task history and renders empty state", () => {
        useAgentTaskHistoryMock.mockReturnValueOnce({ data: { tasks: [] } });

        render(<TaskHistorySidebar />);

        expect(useAgentTaskHistoryMock).toHaveBeenCalledWith(7);
        expect(screen.getByText("Latest Tasks")).toBeInTheDocument();
        expect(screen.getByText("No completed tasks yet")).toBeInTheDocument();
    });

    it("renders completed task timeline items", () => {
        useAgentTaskHistoryMock.mockReturnValueOnce({
            data: {
                tasks: [
                    {
                        id: "1",
                        agentId: "main",
                        completedAt: "2026-05-10T10:00:00.000Z",
                        task: "Added tests",
                        status: "done",
                    },
                    {
                        id: "2",
                        agentId: "ops",
                        completedAt: null,
                        task: "Checked heartbeat",
                        status: "archived",
                    },
                ],
            },
        });

        render(<TaskHistorySidebar />);

        expect(screen.getByText("main")).toBeInTheDocument();
        expect(screen.getByText("Added tests")).toBeInTheDocument();
        expect(screen.getByText("done")).toBeInTheDocument();
        expect(screen.getByText("ops")).toBeInTheDocument();
        expect(screen.getByText("Checked heartbeat")).toBeInTheDocument();
        expect(screen.getByText("-")).toBeInTheDocument();
    });
});
