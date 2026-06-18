import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, jest } from "bun:test";

import { ConfirmModal } from "./ConfirmModal";

describe("ConfirmModal", () => {
    it("renders confirmation content and handles actions", async () => {
        const onConfirm = jest.fn();
        const onCancel = jest.fn();
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
                onConfirm={jest.fn()}
                onCancel={jest.fn()}
            />
        );

        expect(await screen.findByRole("button", { name: "Deploy..." })).toBeDisabled();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    });
});
