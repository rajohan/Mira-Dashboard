import type { CronJob } from "../../../../contracts/cron.ts";
import {
    type ColumnId,
    type Task,
    type TaskAssigneeId,
    type TaskAutomation,
    type TaskAutomationInput,
    type TaskUpdate,
} from "../../../../contracts/tasks.ts";
import { database } from "../../database/connection.ts";
import { objectFallback } from "../../lib/values.ts";
import {
    getOpenClawCronListSnapshot,
    normalizeOpenClawCronJobs,
} from "../../services/openClawCronSnapshot.ts";

type Status = ColumnId;
export type Assignee = TaskAssigneeId;
export interface DatabaseTaskUpdate {
    id: number;
    task_id: number;
    author: Assignee;
    message_md: string;
    created_at: string;
}

export interface DatabaseTask {
    id: number;
    title: string;
    body: string;
    status: Status;
    priority: "low" | "medium" | "high";
    labels_json: string;
    automation_json: string;
    assignee: Assignee | undefined;
    created_at: string;
    updated_at: string;
}

export type DatabaseTaskRow = Omit<DatabaseTask, "assignee"> & {
    assignee: Assignee | null | undefined;
};

function normalizeDatabaseTask(
    task: DatabaseTaskRow | undefined
): DatabaseTask | undefined {
    return task ? { ...task, assignee: task.assignee ?? undefined } : undefined;
}

export function normalizeDatabaseTasks(tasks: DatabaseTaskRow[]): DatabaseTask[] {
    return tasks.map((task) => normalizeDatabaseTask(task)!);
}

export function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Derives the task column from its status labels.
 *
 * @param labels - Task labels in precedence order.
 * @returns Canonical task status.
 */
export function deriveStatus(labels: string[]): Status {
    if (labels.includes("done")) return "done";
    if (labels.includes("blocked")) return "blocked";
    if (labels.includes("in-progress")) return "in-progress";
    return "todo";
}

export function derivePriority(labels: string[]): "low" | "medium" | "high" {
    if (labels.includes("priority-high") || labels.includes("high")) return "high";
    if (labels.includes("priority-low") || labels.includes("low")) return "low";
    return "medium";
}

export function labelsFromTask(task: DatabaseTask): string[] {
    const labels = (() => {
        try {
            const parsed = JSON.parse(task.labels_json) as unknown;
            return Array.isArray(parsed)
                ? parsed.filter((value): value is string => typeof value === "string")
                : [];
        } catch {
            return [];
        }
    })();
    const statusLabel = task.status === "done" ? "done" : task.status;
    if (!labels.includes(statusLabel)) labels.push(statusLabel);
    const priorityLabel = `priority-${task.priority}`;
    if (!labels.includes(priorityLabel)) labels.push(priorityLabel);
    return labels;
}

function parseRecordJson(value: string): Record<string, unknown> {
    try {
        const parsed = JSON.parse(value) as unknown;
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch {
        return {};
    }
}

export function normalizeAutomationInput(
    value: TaskAutomationInput | null | undefined
): string {
    if (!value) {
        return "{}";
    }
    const cronJobId = value.cronJobId.trim();
    if (!cronJobId) return "{}";
    const automation: TaskAutomationInput = {
        type: "cron",
        recurring: value.recurring ?? true,
        cronJobId,
    };
    if (value.scheduleSummary?.trim())
        automation.scheduleSummary = value.scheduleSummary.trim();
    if (value.sessionTarget?.trim())
        automation.sessionTarget = value.sessionTarget.trim();
    if (value.model?.trim()) automation.model = value.model.trim();
    if (value.thinking?.trim()) automation.thinking = value.thinking.trim();
    return JSON.stringify(automation);
}

function stringFromRecord(record: Record<string, unknown> | undefined, key: string) {
    const value = record?.[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberFromRecord(record: Record<string, unknown> | undefined, key: string) {
    const value = record?.[key];
    return typeof value === "number" ? value : undefined;
}

function booleanFromRecord(record: Record<string, unknown> | undefined, key: string) {
    const value = record?.[key];
    return typeof value === "boolean" ? value : undefined;
}

function formatScheduleSummary(schedule: Record<string, unknown> | undefined) {
    if (!schedule) return;
    if (schedule.kind === "cron") {
        const expression = stringFromRecord(schedule, "expr");
        const tz = stringFromRecord(schedule, "tz");
        return expression && tz ? `${expression} (${tz})` : expression;
    }
    if (schedule.kind === "every") {
        const everyMs = numberFromRecord(schedule, "everyMs");
        if (everyMs && everyMs > 0) {
            if (everyMs % 3_600_000 === 0) return `Every ${everyMs / 3_600_000}h`;
            if (everyMs < 60_000)
                return `Every ${Math.max(1, Math.round(everyMs / 1000))}s`;
            return `Every ${Math.round(everyMs / 60_000)}m`;
        }
    } else if (schedule.kind === "at") return stringFromRecord(schedule, "at");
    return typeof schedule.kind === "string" && schedule.kind
        ? schedule.kind
        : "Scheduled";
}

function cronJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

export async function fetchCronJobsById(): Promise<Map<string, CronJob>> {
    try {
        const payload = await getOpenClawCronListSnapshot();
        const jobs = normalizeOpenClawCronJobs<CronJob>(payload);
        return new Map(
            jobs
                .map((job) => [cronJobId(job), job] as const)
                .filter(([id]) => id.length > 0)
        );
    } catch {
        return new Map();
    }
}

function toFrontendAutomation(
    task: DatabaseTask,
    cronJobsById?: Map<string, CronJob>
): TaskAutomation | undefined {
    const stored = parseRecordJson(task.automation_json);
    const id = stringFromRecord(stored, "cronJobId");
    if (!id) return;
    const job = cronJobsById?.get(id);
    const schedule =
        job?.schedule || (stored.schedule as Record<string, unknown> | undefined);
    const payload = job?.payload;
    const state = job?.state;
    return {
        type: "cron",
        recurring: booleanFromRecord(stored, "recurring") ?? true,
        cronJobId: id,
        jobName: job?.name || stringFromRecord(stored, "jobName"),
        enabled: job?.enabled,
        schedule,
        scheduleSummary:
            formatScheduleSummary(schedule) ||
            stringFromRecord(stored, "scheduleSummary"),
        sessionTarget: job?.sessionTarget || stringFromRecord(stored, "sessionTarget"),
        model: stringFromRecord(payload, "model") || stringFromRecord(stored, "model"),
        thinking:
            stringFromRecord(payload, "thinking") || stringFromRecord(stored, "thinking"),
        nextRunAtMs: numberFromRecord(state, "nextRunAtMs"),
        runningAtMs: numberFromRecord(state, "runningAtMs"),
        lastRunAtMs: numberFromRecord(state, "lastRunAtMs"),
        lastRunStatus:
            stringFromRecord(state, "lastRunStatus") ||
            stringFromRecord(state, "lastStatus"),
        lastDurationMs: numberFromRecord(state, "lastDurationMs"),
        source: job ? "cron" : "stored",
    };
}

export function toFrontendTask(
    task: DatabaseTask,
    cronJobsById?: Map<string, CronJob>
): Task {
    const labels = labelsFromTask(task);
    return {
        number: task.id,
        title: task.title,
        body: task.body,
        state: task.status === "done" ? "CLOSED" : "OPEN",
        labels: labels.map((name) => ({ name })),
        assignees: task.assignee ? [{ login: task.assignee, name: task.assignee }] : [],
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        url: `/tasks/${task.id}`,
        automation: toFrontendAutomation(task, cronJobsById),
    };
}

export function toFrontendTaskUpdate(update: DatabaseTaskUpdate): TaskUpdate {
    return {
        id: update.id,
        taskId: update.task_id,
        author: update.author,
        messageMd: update.message_md,
        createdAt: update.created_at,
    };
}

function serializeTaskEventPayload(payload: unknown): string {
    return (
        JSON.stringify(
            typeof payload === "object"
                ? objectFallback(payload as object | undefined)
                : payload
        ) ?? "{}"
    );
}

export function recordEvent(taskId: number, eventType: string, payload: unknown) {
    database
        .prepare(
            `INSERT INTO task_events (task_id, event_type, payload_json, created_at)
             VALUES (?, ?, ?, ?)`
        )
        .run(taskId, eventType, serializeTaskEventPayload(payload), nowIso());
}

export function taskById(id: number): DatabaseTask | undefined {
    const row = database
        .prepare(
            `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
             FROM tasks WHERE id = ?`
        )
        .get(id) as DatabaseTaskRow | undefined;
    return normalizeDatabaseTask(row);
}

export function safeId(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/u.test(value)) {
        return undefined;
    }
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
