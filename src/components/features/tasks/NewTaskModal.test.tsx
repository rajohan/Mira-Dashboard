import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { NewTaskModal } from "./NewTaskModal";

describe("NewTaskModal", () => {
    it("does not render when closed", () => {
        render(<NewTaskModal isOpen={false} onClose={vi.fn()} onSubmit={vi.fn()} />);

        expect(screen.queryByText("New Task")).not.toBeInTheDocument();
    });

    it("submits trimmed task fields and automation metadata", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onSubmit = vi.fn(async () => {});
        render(<NewTaskModal isOpen onClose={onClose} onSubmit={onSubmit} />);

        await user.type(screen.getByLabelText("Title"), "  Add task tests  ");
        await user.type(
            screen.getByPlaceholderText("Task description..."),
            "  Useful details  "
        );
        await user.click(screen.getByRole("button", { name: "High" }));
        await user.click(screen.getByRole("button", { name: "Raymond" }));
        await user.type(screen.getByLabelText("Cron job ID"), "  job-123  ");
        await user.type(screen.getByLabelText("Schedule summary"), " Daily ");
        await user.type(screen.getByLabelText("Session target"), " session:tests ");
        await user.click(screen.getByRole("button", { name: /Create Task/ }));

        expect(onSubmit).toHaveBeenCalledWith(
            "Add task tests",
            "Useful details",
            "high",
            "rajohan",
            {
                cronJobId: "job-123",
                scheduleSummary: "Daily",
                sessionTarget: "session:tests",
            }
        );
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("ignores empty titles and closes from cancel controls", async () => {
        const user = userEvent.setup();
        const onClose = vi.fn();
        const onSubmit = vi.fn();
        render(<NewTaskModal isOpen onClose={onClose} onSubmit={onSubmit} />);

        await user.click(screen.getByRole("button", { name: /Create Task/ }));
        expect(onSubmit).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
