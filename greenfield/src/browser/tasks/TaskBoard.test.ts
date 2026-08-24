import { describe, expect, test } from "bun:test";

import type { TaskSummary } from "../../contracts/taskModel.ts";
import { taskMoveInputForDrop } from "./taskBoardDrop.ts";

const task: TaskSummary = Object.freeze({
    assignee: "mira-2026",
    createdAtMs: 1_800_000_000_000,
    id: "019fd984-63e8-7404-a7da-80c6f243794f",
    labels: [],
    priority: "high",
    status: "todo",
    title: "Move task",
    updatedAtMs: 1_800_000_000_000,
    version: 3,
});

describe("task board drop mapping", () => {
    test("moves only a known versioned task to a different status", () => {
        expect(
            taskMoveInputForDrop([task], `task:${task.id}`, "task-column:in-progress")
        ).toEqual({
            expectedVersion: 3,
            id: task.id,
            status: "in-progress",
        });
        expect(
            taskMoveInputForDrop([task], `task:${task.id}`, "task-column:todo")
        ).toBeUndefined();
        expect(
            taskMoveInputForDrop([task], "task:missing", "task-column:blocked")
        ).toBeUndefined();
        expect(
            taskMoveInputForDrop([task], `task:${task.id}`, "task-column:unknown")
        ).toBeUndefined();
    });
});
