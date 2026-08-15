import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    taskAutomationProfileInputSchema,
    taskDetailSchema,
    taskLabelInputSchema,
    taskLabelListSchema,
    taskProgressUpdateSchema,
    taskTitleSchema,
} from "./taskModel.ts";

const taskId = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
const updateId = "019fc968-1a9b-7761-bf1b-d5b863b0e7b4";
const userId = "019fc968-1a9b-7762-bf1b-d5b863b0e7b4";

describe("task model contracts", () => {
    test("canonicalizes caller labels while requiring canonical persisted order", () => {
        const labels = v.parse(taskLabelInputSchema, ["security", "P1", "backend"]);

        expect(labels).toEqual(["P1", "backend", "security"]);
        expect(Object.isFrozen(labels)).toBeTrue();
        expect(v.safeParse(taskLabelInputSchema, ["P1", "P1"]).success).toBeFalse();
        expect(v.safeParse(taskLabelListSchema, ["security", "P1"]).success).toBeFalse();
        expect(v.parse(taskLabelListSchema, ["P1", "security"])).toEqual([
            "P1",
            "security",
        ]);
    });

    test("keeps compact task text control-safe and task bodies multiline", () => {
        expect(v.parse(taskTitleSchema, "Implement task board")).toBe(
            "Implement task board"
        );
        expect(v.safeParse(taskTitleSchema, " Task title ").success).toBeFalse();
        expect(v.safeParse(taskTitleSchema, "Task\nTitle").success).toBeFalse();
        expect(
            v.parse(taskDetailSchema, {
                bodyMarkdown: "First line\n\nSecond line",
                createdAtMs: 1000,
                id: taskId,
                labels: ["P1"],
                number: 232,
                priority: "high",
                status: "in-progress",
                title: "Implement task board",
                updatedAtMs: 2000,
                version: 2,
            }).bodyMarkdown
        ).toContain("Second line");
    });

    test("validates persisted automation settings without runtime projection", () => {
        expect(
            v.parse(taskAutomationProfileInputSchema, {
                cronJobId: "task-agent-heartbeat",
                kind: "openclaw-cron",
                model: "openai/gpt-5.6-sol",
            })
        ).toEqual({
            cronJobId: "task-agent-heartbeat",
            kind: "openclaw-cron",
            model: "openai/gpt-5.6-sol",
            recurring: true,
        });
        expect(
            v.safeParse(taskAutomationProfileInputSchema, {
                cronJobId: " task-agent-heartbeat ",
                kind: "openclaw-cron",
            }).success
        ).toBeFalse();
    });

    test("binds progress authors and versioned timestamps", () => {
        const update = {
            author: { id: userId, kind: "user" as const, username: "raymond" },
            createdAtMs: 3000,
            id: updateId,
            messageMarkdown: "Implemented the repository boundary.",
            taskId,
            updatedAtMs: 3000,
            version: 1,
        };

        expect(v.parse(taskProgressUpdateSchema, update)).toEqual(update);
        expect(
            v.safeParse(taskProgressUpdateSchema, {
                ...update,
                author: {
                    id: "Not A Principal",
                    kind: "automation",
                    label: "Task automation",
                },
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(taskProgressUpdateSchema, {
                ...update,
                author: { id: "task-automation", kind: "automation" },
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(taskProgressUpdateSchema, {
                ...update,
                author: { id: userId, kind: "user" },
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(taskProgressUpdateSchema, {
                ...update,
                updatedAtMs: 2999,
            }).success
        ).toBeFalse();
    });
});
