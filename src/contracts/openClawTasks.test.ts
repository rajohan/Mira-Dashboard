import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    openClawTaskCancelOutputSchema,
    openClawTaskListInputSchema,
    openClawTaskSummarySchema,
} from "./openClawTasks.ts";

const runningTask = {
    createdAtMs: 1000,
    id: "task-1",
    startedAtMs: 1100,
    status: "running" as const,
    taskId: "task-1",
    updatedAtMs: 1200,
};

describe("OpenClaw task contracts", () => {
    test("requires a non-empty status filter", () => {
        expect(
            v.safeParse(openClawTaskListInputSchema, { statuses: [] }).success
        ).toBeFalse();
    });

    test("rejects contradictory cancellation acknowledgements", () => {
        for (const output of [
            { cancelled: true, found: false },
            { cancelled: false, found: false, task: runningTask },
            { cancelled: false, found: true },
        ]) {
            expect(
                v.safeParse(openClawTaskCancelOutputSchema, output).success
            ).toBeFalse();
        }
        expect(
            v.safeParse(openClawTaskCancelOutputSchema, {
                cancelled: false,
                found: true,
                reason: "Task completed while cancellation was in progress.",
                task: {
                    ...runningTask,
                    endedAtMs: 1300,
                    status: "completed",
                    updatedAtMs: 1300,
                },
            }).success
        ).toBeTrue();
    });

    test("allows optional lifecycle timestamps while rejecting identity and chronology drift", () => {
        expect(
            v.safeParse(openClawTaskSummarySchema, {
                ...runningTask,
                taskId: "different",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(openClawTaskSummarySchema, {
                ...runningTask,
                endedAtMs: 1300,
                updatedAtMs: 1300,
            }).success
        ).toBeTrue();
        expect(
            v.safeParse(openClawTaskSummarySchema, {
                ...runningTask,
                status: "completed",
            }).success
        ).toBeTrue();
        expect(
            v.safeParse(openClawTaskSummarySchema, {
                ...runningTask,
                endedAtMs: 1050,
                status: "failed",
                updatedAtMs: 1300,
            }).success
        ).toBeFalse();
    });
});
