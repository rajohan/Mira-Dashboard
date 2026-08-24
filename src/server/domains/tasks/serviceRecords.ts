import { getTime } from "date-fns";
import * as v from "valibot";

import {
    type TaskAutomationProfile,
    type TaskAutomationProfileInput,
    type TaskDetail,
    type TaskProgressUpdate,
    type TaskSummary,
    taskDetailSchema,
    taskProgressUpdateSchema,
    taskSummarySchema,
} from "../../../contracts/taskModel.ts";
import type {
    TaskAggregateRecord,
    TaskAutomationProfileRecord,
    TaskProgressRecord,
} from "./repositoryTypes.ts";

function taskAutomationProfile(
    record: TaskAutomationProfileRecord
): TaskAutomationProfile {
    return {
        cronJobId: record.cronJobId,
        kind: record.kind,
        ...(record.model === null ? {} : { model: record.model }),
        recurring: record.recurring,
        ...(record.scheduleSummary === null
            ? {}
            : { scheduleSummary: record.scheduleSummary }),
        ...(record.sessionTarget === null ? {} : { sessionTarget: record.sessionTarget }),
        ...(record.thinking === null ? {} : { thinking: record.thinking }),
    };
}

function taskSummaryInput(record: TaskAggregateRecord) {
    return {
        ...(record.task.assignee === null ? {} : { assignee: record.task.assignee }),
        ...(record.automation === undefined
            ? {}
            : { automation: taskAutomationProfile(record.automation) }),
        createdAtMs: getTime(record.task.createdAt),
        id: record.task.id,
        labels: record.labels.map(({ label }) => label),
        number: record.task.number,
        priority: record.task.priority,
        status: record.task.status,
        title: record.task.title,
        updatedAtMs: getTime(record.task.updatedAt),
        version: record.task.version,
    };
}

/**
 * Maps validated normalized persistence rows to one public task summary.
 * @param record Complete normalized task aggregate.
 * @returns Validated public summary.
 */
export function toTaskSummary(record: TaskAggregateRecord): TaskSummary {
    return v.parse(taskSummarySchema, taskSummaryInput(record));
}

/**
 * Maps validated normalized persistence rows to one public complete task.
 * @param record Complete normalized task aggregate.
 * @returns Validated public task detail.
 */
export function toTaskDetail(record: TaskAggregateRecord): TaskDetail {
    return v.parse(taskDetailSchema, {
        ...taskSummaryInput(record),
        ...(record.task.bodyMarkdown === null
            ? {}
            : { bodyMarkdown: record.task.bodyMarkdown }),
    });
}

/**
 * Maps one validated progress row to its public immutable-author representation.
 * @param record Validated progress persistence row.
 * @returns Validated public progress update.
 */
export function toTaskProgressUpdate(record: TaskProgressRecord): TaskProgressUpdate {
    const author =
        record.authorKind === "automation"
            ? {
                  id: record.authorId,
                  kind: record.authorKind,
                  label: record.authorLabel,
              }
            : {
                  id: record.authorId,
                  kind: record.authorKind,
                  username: record.authorUsername,
              };
    return v.parse(taskProgressUpdateSchema, {
        author,
        createdAtMs: getTime(record.createdAt),
        id: record.id,
        messageMarkdown: record.messageMarkdown,
        taskId: record.taskId,
        updatedAtMs: getTime(record.updatedAt),
        version: record.version,
    });
}

/**
 * Tests whether normalized stored labels exactly match canonical caller labels.
 * @param record Complete normalized task aggregate.
 * @param labels Canonical requested labels.
 * @returns Whether both label sequences are identical.
 */
export function taskLabelsEqual(
    record: TaskAggregateRecord,
    labels: readonly string[]
): boolean {
    return (
        record.labels.length === labels.length &&
        record.labels.every(({ label }, index) => label === labels[index])
    );
}

/**
 * Tests whether a persisted automation link exactly matches one caller profile.
 * @param record Optional persisted automation link.
 * @param input Requested automation profile or explicit removal.
 * @returns Whether persisted and requested states are identical.
 */
export function taskAutomationEqual(
    record: TaskAutomationProfileRecord | undefined,
    input: TaskAutomationProfileInput | null
): boolean {
    if (record === undefined || input === null) {
        return record === undefined && input === null;
    }
    return (
        record.cronJobId === input.cronJobId &&
        record.kind === input.kind &&
        record.model === (input.model ?? null) &&
        record.recurring === input.recurring &&
        record.scheduleSummary === (input.scheduleSummary ?? null) &&
        record.sessionTarget === (input.sessionTarget ?? null) &&
        record.thinking === (input.thinking ?? null)
    );
}
