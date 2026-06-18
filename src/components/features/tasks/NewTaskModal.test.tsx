import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { NewTaskModal } from "./NewTaskModal";

describe("NewTaskModal", () => {
    it("does not render when closed", () => {
        render(<NewTaskModal isOpen={false} onClose={jest.fn()} onSubmit={jest.fn()} />);

        expect(screen.queryByText("New Task")).not.toBeInTheDocument();
    });

    it("submits trimmed task fields and automation metadata", async () => {
        const user = userEvent.setup();
        const onClose = jest.fn();
        const onSubmit = jest.fn(async () => {});
        render(<NewTaskModal isOpen onClose={onClose} onSubmit={onSubmit} />);

        fireEvent.change(screen.getByLabelText("Title"), {
            target: { value: "  Add task tests  " },
        });
        fireEvent.change(screen.getByPlaceholderText("Task description..."), {
            target: { value: "  Useful details  " },
        });
        await user.click(screen.getByRole("button", { name: "High" }));
        await user.click(screen.getByRole("button", { name: "Mira" }));
        await user.click(screen.getByRole("button", { name: "Raymond" }));
        fireEvent.change(screen.getByLabelText("Cron job ID"), {
            target: { value: "  job-123  " },
        });
        fireEvent.change(screen.getByLabelText("Schedule summary"), {
            target: { value: " Daily " },
        });
        fireEvent.change(screen.getByLabelText("Session target"), {
            target: { value: " session:tests " },
        });
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
        const onClose = jest.fn();
        const onSubmit = jest.fn();
        render(<NewTaskModal isOpen onClose={onClose} onSubmit={onSubmit} />);

        await user.click(screen.getByRole("button", { name: /Create Task/ }));
        expect(onSubmit).not.toHaveBeenCalled();

        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("submits without optional body or automation", async () => {
        const user = userEvent.setup();
        const onSubmit = jest.fn(async () => {});
        render(<NewTaskModal isOpen onClose={jest.fn()} onSubmit={onSubmit} />);

        fireEvent.change(screen.getByLabelText("Title"), {
            target: { value: "Minimal task" },
        });
        fireEvent.change(screen.getByPlaceholderText("Task description..."), {
            target: { value: " ".repeat(3) },
        });
        await user.click(screen.getByRole("button", { name: /Create Task/ }));

        expect(onSubmit).toHaveBeenCalledWith(
            "Minimal task",
            undefined,
            "medium",
            "mira-2026",
            undefined
        );
    });

    it("shows the submitting state while creation is pending", async () => {
        const user = userEvent.setup();
        const onSubmit = jest.fn(() => new Promise<void>(() => {}));
        render(<NewTaskModal isOpen onClose={jest.fn()} onSubmit={onSubmit} />);

        fireEvent.change(screen.getByLabelText("Title"), {
            target: { value: "Slow task" },
        });
        await user.click(screen.getByRole("button", { name: /Create Task/ }));

        expect(screen.getByText("Creating...")).toBeInTheDocument();
    });

    it("labels the icon-only close button", async () => {
        const user = userEvent.setup();
        const onClose = jest.fn();
        render(<NewTaskModal isOpen onClose={onClose} onSubmit={jest.fn()} />);

        await user.click(screen.getByRole("button", { name: "Close new task modal" }));

        expect(onClose).toHaveBeenCalledTimes(1);
    });
});
