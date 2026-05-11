import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { ConfirmModal } from "./ConfirmModal";

describe("ConfirmModal", () => {
    it("renders confirmation content and handles actions", async () => {
        const onConfirm = vi.fn();
        const onCancel = vi.fn();
        render(
            <ConfirmModal
                isOpen
                title="Delete task"
                message="This cannot be undone"
                confirmLabel="Delete"
                onConfirm={onConfirm}
                onCancel={onCancel}
                danger
            />
        );

        expect(screen.getByRole("dialog", { name: "Delete task" })).toBeInTheDocument();
        expect(screen.getByText("This cannot be undone")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Delete" }));
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onConfirm).toHaveBeenCalledTimes(1);
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("shows loading label and disables actions", async () => {
        render(
            <ConfirmModal
                isOpen
                title="Deploy"
                message="Deploy now?"
                confirmLabel="Deploy"
                loading
                onConfirm={vi.fn()}
                onCancel={vi.fn()}
            />
        );

        expect(await screen.findByRole("button", { name: "Deploy..." })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
});
