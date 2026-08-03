import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { TaskUpdate } from "../../../../contracts/tasks";
import { TaskProgressUpdates } from "../../components/features/tasks/TaskProgressUpdates";
const originalFetch = fetch;
const originalAnimationFrame = {
    cancelAnimationFrame,
    requestAnimationFrame,
};
const animationFrameState = {
    id: 0,
    frames: new Map<number, FrameRequestCallback>(),
};
function requestAnimationFrameForTest(callback: FrameRequestCallback): number {
    const id = ++animationFrameState.id;
    animationFrameState.frames.set(id, callback);
    return id;
}
function cancelAnimationFrameForTest(handle: number): void {
    animationFrameState.frames.delete(handle);
}
beforeEach(() => {
    Object.defineProperties(globalThis, {
        requestAnimationFrame: {
            configurable: true,
            value: requestAnimationFrameForTest,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: cancelAnimationFrameForTest,
            writable: true,
        },
    });
});
afterEach(() => {
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
        requestAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.requestAnimationFrame,
            writable: true,
        },
        cancelAnimationFrame: {
            configurable: true,
            value: originalAnimationFrame.cancelAnimationFrame,
            writable: true,
        },
    });
    animationFrameState.frames.clear();
});
describe("Dashboard task progress components", () => {
    it("retains progress drafts after failed submissions and renders unknown authors safely", async () => {
        const user = userEvent.setup();
        const addResult = Promise.withResolvers<void>();
        const editResult = Promise.withResolvers<void>();
        const onAddUpdate = jest.fn(() => addResult.promise);
        const onEditUpdate = jest.fn(() => editResult.promise);
        render(
            <TaskProgressUpdates
                updates={[
                    {
                        id: 0,
                        taskId: 7,
                        author: "external-agent",
                        messageMd: "Original progress",
                        createdAt: "2026-07-31T08:00:00.000Z",
                    } as unknown as TaskUpdate,
                ]}
                onAddUpdate={onAddUpdate}
                onDeleteUpdate={jest.fn()}
                onEditUpdate={onEditUpdate}
            />
        );
        expect(screen.getByText(/@external-agent/u)).toBeInTheDocument();
        expect(
            screen.queryByRole("link", {
                name: "@external-agent",
            })
        ).not.toBeInTheDocument();
        const addInput = screen.getByLabelText("Add progress update");
        await user.type(addInput, "Unsaved addition");
        await user.click(
            screen.getByRole("button", {
                name: "Add Update",
            })
        );
        expect(onAddUpdate).toHaveBeenCalledWith("Unsaved addition");
        expect(
            screen.getByRole("button", {
                name: "Adding...",
            })
        ).toBeDisabled();
        await act(async () => {
            addResult.reject(new Error("add update failed"));
            await Promise.resolve();
        });
        expect(await screen.findByText("add update failed")).toBeInTheDocument();
        expect(addInput).toHaveValue("Unsaved addition");
        await user.click(
            screen.getByRole("button", {
                name: "Edit progress update #0",
            })
        );
        const editInput = screen.getByLabelText("Message for progress update #0");
        await user.clear(editInput);
        await user.type(editInput, "Unsaved edit");
        await user.click(
            screen.getByRole("button", {
                name: "Save",
            })
        );
        expect(onEditUpdate).toHaveBeenCalledWith(0, "Unsaved edit");
        expect(
            screen.getByRole("button", {
                name: "Saving...",
            })
        ).toBeDisabled();
        await act(async () => {
            editResult.reject(new Error("edit update failed"));
            await Promise.resolve();
        });
        expect(await screen.findByText("edit update failed")).toBeInTheDocument();
        expect(editInput).toHaveValue("Unsaved edit");
    });
});
