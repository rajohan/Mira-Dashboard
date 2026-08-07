import { describe, expect, test } from "bun:test";

import type { TaskDetail } from "../../contracts/taskModel.ts";
import {
    createTaskInputFromEditor,
    taskEditorValues,
    taskLabelsFromText,
    updateTaskInputFromEditor,
} from "./taskEditorForm.ts";

const task: TaskDetail = Object.freeze({
    assignee: "mira-2026",
    automation: {
        cronJobId: "daily-task-runner",
        kind: "openclaw-cron" as const,
        model: "gpt-5.6-sol",
        recurring: true,
        scheduleSummary: "Every morning",
    },
    bodyMarkdown: "Existing body",
    createdAtMs: 1_800_000_000_000,
    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
    labels: ["database", "delivery"],
    priority: "high",
    status: "in-progress",
    title: "Existing task",
    updatedAtMs: 1_800_000_000_001,
    version: 4,
});

describe("task editor mapping", () => {
    test("normalizes comma-separated labels through the task contract", () => {
        expect(taskLabelsFromText(" delivery, database ")).toEqual([
            "database",
            "delivery",
        ]);
        expect(() => taskLabelsFromText("duplicate, duplicate")).toThrow();
    });

    test("defaults new browser tasks to Mira without inventing other relationships", () => {
        const values = taskEditorValues();
        values.title = "Create task";
        values.labelsText = "phase-three, tasks";

        expect(createTaskInputFromEditor(values)).toEqual({
            assignee: "mira-2026",
            labels: ["phase-three", "tasks"],
            priority: "medium",
            status: "todo",
            title: "Create task",
        });
    });

    test("preserves versioned content and can explicitly remove automation", () => {
        const values = taskEditorValues(task);
        values.automationEnabled = false;
        values.bodyMarkdown = "";

        expect(updateTaskInputFromEditor(task, values)).toEqual({
            expectedVersion: 4,
            id: task.id,
            patch: {
                automation: null,
                bodyMarkdown: null,
                labels: ["database", "delivery"],
                priority: "high",
                title: "Existing task",
            },
        });
    });
});
