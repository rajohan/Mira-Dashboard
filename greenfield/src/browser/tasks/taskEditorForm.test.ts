import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import type { TaskDetail } from "../../contracts/taskModel.ts";
import {
    createTaskInputFromEditor,
    taskEditorFormSchema,
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
    labels: ["database", "needs,triage"],
    priority: "high",
    status: "in-progress",
    title: "Existing task",
    updatedAtMs: 1_800_000_000_001,
    version: 4,
});

describe("task editor mapping", () => {
    test("normalizes line-separated labels without consuming commas", () => {
        expect(taskLabelsFromText(" needs,triage\ndatabase ")).toEqual([
            "database",
            "needs,triage",
        ]);
        expect(() => taskLabelsFromText("duplicate\nduplicate")).toThrow();
    });

    test("accepts the full UTF-16 editor budget for astral labels", () => {
        const firstEmojiCodePoint = 128_512;
        const labels = Array.from(
            { length: 20 },
            (_, index) =>
                `${String.fromCodePoint(firstEmojiCodePoint + index)}${"\u{1F600}".repeat(63)}`
        );
        const values = taskEditorValues();
        values.labelsText = labels.join("\r\n");
        values.title = "Astral labels";

        expect(v.parse(taskEditorFormSchema, values).labelsText).toBe(values.labelsText);
        expect(taskLabelsFromText(values.labelsText)).toEqual(labels);
    });

    test("defaults new browser tasks to Mira without inventing other relationships", () => {
        const values = taskEditorValues();
        values.title = "Create task";
        values.labelsText = "phase-three\ntasks";

        expect(createTaskInputFromEditor(values)).toEqual({
            assignee: "mira-2026",
            labels: ["phase-three", "tasks"],
            priority: "medium",
            status: "todo",
            title: "Create task",
        });
    });

    test("rejects noncanonical outer whitespace in every automation text field", () => {
        const fields = [
            "automationCronJobId",
            "automationModel",
            "automationScheduleSummary",
            "automationSessionTarget",
            "automationThinking",
        ] as const;

        for (const field of fields) {
            const values = taskEditorValues();
            values.automationEnabled = true;
            values.automationCronJobId = "daily-task-runner";
            values.title = "Create automated task";
            values[field] = " noncanonical ";

            expect(v.safeParse(taskEditorFormSchema, values).success).toBeFalse();
        }
    });

    test("preserves versioned content and can explicitly remove automation", () => {
        const values = taskEditorValues(task);
        expect(values.labelsText).toBe("database\nneeds,triage");
        values.automationEnabled = false;
        values.bodyMarkdown = "";
        const parsed = v.parse(taskEditorFormSchema, values);

        expect(updateTaskInputFromEditor(task, parsed)).toEqual({
            expectedVersion: 4,
            id: task.id,
            patch: {
                automation: null,
                bodyMarkdown: null,
                labels: ["database", "needs,triage"],
                priority: "high",
                title: "Existing task",
            },
        });
    });

    test("ignores stale invalid automation drafts while automation is disabled", () => {
        const values = taskEditorValues(task);
        values.automationEnabled = false;
        values.automationCronJobId = " noncanonical ";
        values.automationModel = " noncanonical ";
        values.automationScheduleSummary = " noncanonical ";
        values.automationSessionTarget = " noncanonical ";
        values.automationThinking = " noncanonical ";

        const parsed = v.parse(taskEditorFormSchema, values);

        expect(updateTaskInputFromEditor(task, parsed).patch.automation).toBeNull();
    });
});
