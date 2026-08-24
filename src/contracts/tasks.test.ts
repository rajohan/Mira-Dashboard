import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    createTaskInputSchema,
    listTaskLabelsInputSchema,
    listTaskLabelsResultSchema,
    listTaskProgressInputSchema,
    listTaskProgressResultSchema,
    listTasksInputSchema,
    listTasksResultSchema,
    taskProcedureContracts,
    taskLabelSuggestionMaximum,
    updateTaskInputSchema,
} from "./tasks.ts";

const firstTaskId = "019fc968-1a9b-7764-bf1b-d5b863b0e7b4";
const secondTaskId = "019fc968-1a9b-7763-bf1b-d5b863b0e7b4";
const firstUpdateId = "019fc968-1a9b-7766-bf1b-d5b863b0e7b4";
const secondUpdateId = "019fc968-1a9b-7765-bf1b-d5b863b0e7b4";
const userId = "019fc968-1a9b-7762-bf1b-d5b863b0e7b4";

function task(id: string, updatedAtMs: number) {
    return {
        createdAtMs: 1000,
        id,
        labels: ["P1"],
        number: 1,
        priority: "high" as const,
        status: "in-progress" as const,
        title: "Implement task board",
        updatedAtMs,
        version: 1,
    };
}

function update(id: string, createdAtMs: number) {
    return {
        author: { id: userId, kind: "user" as const, username: "raymond" },
        createdAtMs,
        id,
        messageMarkdown: "Implemented one bounded slice.",
        taskId: firstTaskId,
        updatedAtMs: createdAtMs,
        version: 1,
    };
}

describe("task procedure contracts", () => {
    test("defaults page budgets and canonicalizes bounded filters", () => {
        expect(v.parse(listTasksInputSchema, {})).toEqual({ limit: 50 });
        expect(v.parse(listTaskProgressInputSchema, { taskId: firstTaskId })).toEqual({
            limit: 20,
            taskId: firstTaskId,
        });
        expect(
            v.parse(listTasksInputSchema, {
                filters: {
                    assignees: ["rajohan", "mira-2026"],
                    automation: "recurring",
                    priorities: ["medium", "high"],
                    statuses: ["todo", "done"],
                },
            }).filters
        ).toEqual({
            assignees: ["mira-2026", "rajohan"],
            automation: "recurring",
            priorities: ["high", "medium"],
            statuses: ["done", "todo"],
        });
        expect(v.safeParse(listTasksInputSchema, { limit: 101 }).success).toBeFalse();
        expect(
            v.safeParse(listTasksInputSchema, {
                filters: { automation: "automated" },
            }).success
        ).toBeFalse();
    });

    test("requires newest-first task order and an exact continuation cursor", () => {
        const first = task(firstTaskId, 3000);
        const second = task(secondTaskId, 3000);

        expect(
            v.parse(listTasksResultSchema, {
                nextCursor: { id: second.id, updatedAtMs: second.updatedAtMs },
                tasks: [first, second],
            }).tasks
        ).toHaveLength(2);
        expect(
            v.safeParse(listTasksResultSchema, { tasks: [second, first] }).success
        ).toBeFalse();
        expect(
            v.safeParse(listTasksResultSchema, {
                nextCursor: { id: first.id, updatedAtMs: first.updatedAtMs },
                tasks: [first, second],
            }).success
        ).toBeFalse();
    });

    test("bounds the distinct task-label catalog in canonical order", () => {
        expect(v.parse(listTaskLabelsInputSchema, {})).toEqual({});
        const result = v.parse(listTaskLabelsResultSchema, {
            labels: ["alpha", "ops"],
            truncated: false,
        });
        expect(result.labels).toEqual(["alpha", "ops"]);
        expect(Object.isFrozen(result.labels)).toBeTrue();
        expect(
            v.safeParse(listTaskLabelsResultSchema, {
                labels: ["ops", "alpha"],
                truncated: false,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(listTaskLabelsResultSchema, {
                labels: ["ops", "ops"],
                truncated: false,
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(listTaskLabelsResultSchema, {
                labels: Array.from(
                    { length: taskLabelSuggestionMaximum + 1 },
                    (_, index) => `label-${String(index).padStart(3, "0")}`
                ),
                truncated: true,
            }).success
        ).toBeFalse();
    });

    test("requires newest-first progress order and an exact continuation cursor", () => {
        const first = update(firstUpdateId, 4000);
        const second = update(secondUpdateId, 4000);

        expect(
            v.parse(listTaskProgressResultSchema, {
                nextCursor: { createdAtMs: second.createdAtMs, id: second.id },
                updates: [first, second],
            }).updates
        ).toHaveLength(2);
        expect(
            v.safeParse(listTaskProgressResultSchema, {
                updates: [second, first],
            }).success
        ).toBeFalse();
    });

    test("accepts explicit clears but rejects empty or misspelled task patches", () => {
        expect(
            v.parse(updateTaskInputSchema, {
                expectedVersion: 2,
                id: firstTaskId,
                patch: { automation: null, bodyMarkdown: null, labels: [] },
            }).patch
        ).toEqual({ automation: null, bodyMarkdown: null, labels: [] });
        expect(
            v.safeParse(updateTaskInputSchema, {
                expectedVersion: 2,
                id: firstTaskId,
                patch: {},
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(createTaskInputSchema, {
                titel: "Misspelled",
                title: "Valid title",
            }).success
        ).toBeFalse();
    });

    test("registers the complete task parity surface with explicit capabilities", () => {
        expect(taskProcedureContracts.map(({ name }) => name)).toEqual([
            "tasks.list",
            "tasks.listLabels",
            "tasks.get",
            "tasks.listUpdates",
            "tasks.create",
            "tasks.update",
            "tasks.assign",
            "tasks.move",
            "tasks.delete",
            "tasks.addUpdate",
            "tasks.updateProgress",
            "tasks.deleteProgress",
        ]);
        for (const contract of taskProcedureContracts) {
            expect(contract.access).toMatchObject({
                capabilities: [contract.kind === "query" ? "tasks:read" : "tasks:write"],
            });
        }
    });
});
