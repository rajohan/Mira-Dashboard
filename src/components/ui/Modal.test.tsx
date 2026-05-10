import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Modal } from "./Modal";

describe("Modal", () => {
    it("renders dialog title, children and closes from header button", async () => {
        const onClose = vi.fn();
        render(
            <Modal isOpen onClose={onClose} title="Settings" size="lg">
                <p>Modal body</p>
            </Modal>
        );

        expect(screen.getByRole("dialog", { name: "Settings" })).toBeInTheDocument();
        expect(screen.getByText("Modal body")).toBeInTheDocument();
        expect(screen.getByRole("dialog").querySelector(".max-w-lg")).toBeInTheDocument();

        await userEvent.click(screen.getByRole("button"));

        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("can render without a title", () => {
        render(
            <Modal isOpen onClose={vi.fn()}>
                <p>Untitled body</p>
            </Modal>
        );

        expect(screen.getByText("Untitled body")).toBeInTheDocument();
        expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    });
});
