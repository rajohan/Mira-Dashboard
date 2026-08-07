import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    taskAutomationProfileInsertSchema,
    taskAutomationProfileSelectSchema,
} from "./taskAutomationProfiles.ts";
import { taskEventInsertSchema, taskEventSelectSchema } from "./taskEvents.ts";
import { taskLabelInsertSchema, taskLabelSelectSchema } from "./taskLabels.ts";
import { taskInsertSchema, taskSelectSchema, taskUpdateSchema } from "./tasks.ts";
import {
    taskProgressRowInsertSchema,
    taskProgressRowSelectSchema,
    taskProgressRowUpdateSchema,
} from "./taskUpdates.ts";

const taskId = "019fc968-1a9b-7760-bf1b-d5b863b0e7b4";
const updateId = "019fc968-1a9b-7761-bf1b-d5b863b0e7b4";
const eventId = "019fc968-1a9b-7762-bf1b-d5b863b0e7b4";
const userId = "019fc968-1a9b-7763-bf1b-d5b863b0e7b4";
const createdAt = new Date(1000);
const updatedAt = new Date(2000);

const taskInsert = {
    assignee: "mira-2026" as const,
    bodyMarkdown: "Implement persistence and transport.",
    createdAt,
    id: taskId,
    priority: "high" as const,
    status: "in-progress" as const,
    title: "Implement task domain",
    updatedAt,
};

describe("task database row validation", () => {
    test("validates task insert, select, and mutable fields", () => {
        expect(v.parse(taskInsertSchema, taskInsert)).toEqual(taskInsert);
        expect(v.parse(taskSelectSchema, { ...taskInsert, version: 1 })).toEqual({
            ...taskInsert,
            version: 1,
        });
        expect(
            v.parse(taskUpdateSchema, {
                assignee: null,
                bodyMarkdown: null,
                priority: "medium",
                status: "blocked",
                title: "Waiting for review",
                updatedAt,
                version: 2,
            })
        ).toBeDefined();

        expect(
            v.safeParse(taskInsertSchema, {
                ...taskInsert,
                title: "Hidden\u200Bformat",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(taskSelectSchema, {
                ...taskInsert,
                updatedAt: new Date(999),
                version: 1,
            }).success
        ).toBeFalse();
    });

    test("validates normalized labels and automation profiles", () => {
        const label = { label: "backend", taskId };
        expect(v.parse(taskLabelInsertSchema, label)).toEqual(label);
        expect(v.parse(taskLabelSelectSchema, label)).toEqual(label);

        const profile = {
            cronJobId: "task-agent-heartbeat",
            kind: "openclaw-cron" as const,
            model: null,
            recurring: true,
            scheduleSummary: "Every hour",
            sessionTarget: null,
            taskId,
            thinking: "high",
        };
        expect(v.parse(taskAutomationProfileInsertSchema, profile)).toEqual(profile);
        expect(v.parse(taskAutomationProfileSelectSchema, profile)).toEqual(profile);
        expect(
            v.safeParse(taskAutomationProfileInsertSchema, {
                ...profile,
                cronJobId: " task-agent-heartbeat ",
            }).success
        ).toBeFalse();
    });

    test("validates immutable progress authorship and versioned edits", () => {
        const insert = {
            authorId: userId,
            authorKind: "user" as const,
            createdAt,
            id: updateId,
            messageMarkdown: "Repository implemented.",
            taskId,
            updatedAt: createdAt,
        };
        expect(v.parse(taskProgressRowInsertSchema, insert)).toEqual(insert);
        expect(v.parse(taskProgressRowSelectSchema, { ...insert, version: 1 })).toEqual({
            ...insert,
            version: 1,
        });
        expect(
            v.parse(taskProgressRowUpdateSchema, {
                messageMarkdown: "Repository and tests implemented.",
                updatedAt,
                version: 2,
            })
        ).toBeDefined();
        expect(
            v.safeParse(taskProgressRowInsertSchema, {
                ...insert,
                authorId: "Not A Principal",
                authorKind: "automation",
            }).success
        ).toBeFalse();
    });

    test("validates bounded append-only event rows", () => {
        const event = {
            actorId: userId,
            actorKind: "user" as const,
            createdAt,
            eventType: "created" as const,
            id: eventId,
            payloadJson: '{"priority":"high","status":"in-progress"}',
            taskId,
        };
        expect(v.parse(taskEventInsertSchema, event)).toEqual(event);
        expect(v.parse(taskEventSelectSchema, event)).toEqual(event);
        expect(
            v.safeParse(taskEventInsertSchema, {
                ...event,
                payloadJson: "[]",
            }).success
        ).toBeFalse();
        expect(
            v.safeParse(taskEventInsertSchema, {
                ...event,
                eventType: "unknown",
            }).success
        ).toBeFalse();
    });
});
