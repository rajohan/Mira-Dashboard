import type { CronJob } from "../../../contracts/cron.ts";
import {
    type ColumnId,
    parseAssignTaskRequest,
    parseCreateTaskRequest,
    parseCreateTaskUpdateRequest,
    parseMoveTaskRequest,
    parseUpdateTaskRequest,
    parseUpdateTaskUpdateRequest,
    type Task,
    TASK_ASSIGNEES,
    type TaskAssigneeId,
    type TaskAutomation,
    type TaskAutomationInput,
    type TaskMutationResponse,
    type TaskUpdate,
} from "../../../contracts/tasks.ts";
import { database, sqlNullable } from "../database.ts";
import gateway from "../gateway.ts";
import { json } from "../http.ts";
import { createStructuredLogger } from "../lib/structuredLogger.ts";
import { objectFallback } from "../lib/values.ts";
import { isDevelopmentExternalNotificationSuppressed } from "../requestPolicy.ts";
import {
    type ParametersRequest,
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../routeSupport.ts";
import {
    getOpenClawCronListSnapshot,
    normalizeOpenClawCronJobs,
} from "../services/openClawCronSnapshot.ts";

type Status = ColumnId;
type Assignee = TaskAssigneeId;
const logger = createStructuredLogger("tasks");

interface DatabaseTaskUpdate {
    id: number;
    task_id: number;
    author: Assignee;
    message_md: string;
    created_at: string;
}

interface DatabaseTask {
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

type DatabaseTaskRow = Omit<DatabaseTask, "assignee"> & {
    assignee: Assignee | null | undefined;
};

function normalizeDatabaseTask(
    task: DatabaseTaskRow | undefined
): DatabaseTask | undefined {
    return task ? { ...task, assignee: task.assignee ?? undefined } : undefined;
}

function normalizeDatabaseTasks(tasks: DatabaseTaskRow[]): DatabaseTask[] {
    return tasks.map((task) => normalizeDatabaseTask(task)!);
}

function nowIso(): string {
    return new Date().toISOString();
}

/**
 * Derives the task column from its status labels.
 *
 * @param labels - Task labels in precedence order.
 * @returns Canonical task status.
 */
function deriveStatus(labels: string[]): Status {
    if (labels.includes("done")) return "done";
    if (labels.includes("blocked")) return "blocked";
    if (labels.includes("in-progress")) return "in-progress";
    return "todo";
}

function derivePriority(labels: string[]): "low" | "medium" | "high" {
    if (labels.includes("priority-high") || labels.includes("high")) return "high";
    if (labels.includes("priority-low") || labels.includes("low")) return "low";
    return "medium";
}

function labelsFromTask(task: DatabaseTask): string[] {
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

function normalizeAutomationInput(value: TaskAutomationInput | null | undefined): string {
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

async function fetchCronJobsById(): Promise<Map<string, CronJob>> {
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

function toFrontendTask(task: DatabaseTask, cronJobsById?: Map<string, CronJob>): Task {
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

function toFrontendTaskUpdate(update: DatabaseTaskUpdate): TaskUpdate {
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

function recordEvent(taskId: number, eventType: string, payload: unknown) {
    database
        .prepare(
            `INSERT INTO task_events (task_id, event_type, payload_json, created_at)
             VALUES (?, ?, ?, ?)`
        )
        .run(taskId, eventType, serializeTaskEventPayload(payload), nowIso());
}

type MiraTaskNotificationEvent =
    | "assigned"
    | "created"
    | "deleted"
    | "progress"
    | "updated";

function miraTaskNotificationMessage(
    eventType: MiraTaskNotificationEvent,
    task: { id: number; title: string }
): string {
    const taskLabel = `#${task.id} ${task.title}`;
    if (eventType === "progress") {
        return `Task ${eventType}: ${taskLabel}. This existing Mira task has new progress and may need attention when the current work is clear.`;
    }

    if (eventType === "created" || eventType === "assigned") {
        return `Task ${eventType}: ${taskLabel}. This task is assigned to Mira and may need attention when the current work is clear.`;
    }

    return `Task ${eventType}: ${taskLabel}. This Mira-assigned task changed and may need attention when the current work is clear.`;
}

async function notifyMira(
    eventType: MiraTaskNotificationEvent,
    task: { id: number; title: string }
) {
    if (isDevelopmentExternalNotificationSuppressed()) return;
    try {
        await gateway.sendSessionMessage(
            "main",
            miraTaskNotificationMessage(eventType, task)
        );
    } catch (error) {
        logger.error("tasks.mira_notification_failed", { error });
    }
}

function taskById(id: number): DatabaseTask | undefined {
    const row = database
        .prepare(
            `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
             FROM tasks WHERE id = ?`
        )
        .get(id) as DatabaseTaskRow | undefined;
    return normalizeDatabaseTask(row);
}

function safeId(value: string | undefined): number | undefined {
    if (!value || !/^\d+$/u.test(value)) {
        return undefined;
    }
    const id = Number(value);
    return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export const taskRoutes = {
    "/api/tasks": {
        GET: async (request: Request) => {
            try {
                const rows = database
                    .prepare(
                        `SELECT id, title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at
                         FROM tasks
                         ORDER BY datetime(updated_at) DESC, id DESC`
                    )
                    .all() as DatabaseTaskRow[];
                const cronJobsById = await fetchCronJobsById();
                return json(
                    normalizeDatabaseTasks(rows).map((task) =>
                        toFrontendTask(task, cronJobsById)
                    )
                );
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "tasks_list_failed",
                    context: "tasks.list",
                    message: "Failed to list tasks",
                });
            }
        },

        POST: async (request: Request) => {
            try {
                const body = await readApiJson(request, parseCreateTaskRequest);
                const title = body.title;
                const assignee = body.assignee ?? undefined;
                const now = nowIso();
                const labels = body.labels ?? [];
                const taskBody = body.body ?? "";
                const status = deriveStatus(labels);
                const priority = derivePriority(labels);
                const id = database.transaction(() => {
                    const result = database
                        .prepare(
                            `INSERT INTO tasks (title, body, status, priority, labels_json, automation_json, assignee, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                        )
                        .run(
                            title,
                            taskBody,
                            status,
                            priority,
                            JSON.stringify(labels),
                            normalizeAutomationInput(body.automation),
                            sqlNullable(assignee),
                            now,
                            now
                        );
                    const taskId = Number(result.lastInsertRowid);
                    recordEvent(taskId, "created", {
                        title,
                        status,
                        priority,
                        assignee,
                    });
                    return taskId;
                })();
                if (assignee === TASK_ASSIGNEES.mira.id) {
                    void notifyMira("created", { id, title });
                }
                return json(toFrontendTask(taskById(id) as DatabaseTask), {
                    status: 201,
                });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_create_failed",
                    context: "tasks.create",
                    message: "Failed to create task",
                });
            }
        },
    },

    "/api/tasks/:id": {
        GET: async (request: ParametersRequest<"id">) => {
            try {
                const id = safeId(request.params.id);
                if (id === undefined)
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid id",
                        status: 400,
                    });
                const row = taskById(id);
                if (!row)
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                return json(toFrontendTask(row, await fetchCronJobsById()));
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_lookup_failed",
                    context: "tasks.get",
                    message: "Failed to load task",
                });
            }
        },

        PATCH: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined)
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            const existing = taskById(id);
            if (!existing)
                return routeFailureResponse({
                    context: "task",
                    message: "Task not found",
                    status: 404,
                });
            try {
                const body = await readApiJson(request, parseUpdateTaskRequest);
                const labels = body.labels ?? labelsFromTask(existing);
                const status = deriveStatus(labels);
                const priority = derivePriority(labels);
                const title = body.title ?? existing.title;
                const taskBody = body.body ?? existing.body;
                const automationJson =
                    body.automation === undefined
                        ? existing.automation_json
                        : normalizeAutomationInput(body.automation);
                database.transaction(() => {
                    database
                        .prepare(
                            `UPDATE tasks
                         SET title = ?, body = ?, status = ?, priority = ?, labels_json = ?, automation_json = ?, updated_at = ?
                         WHERE id = ?`
                        )
                        .run(
                            title,
                            taskBody,
                            status,
                            priority,
                            JSON.stringify(labels),
                            automationJson,
                            nowIso(),
                            id
                        );
                    recordEvent(id, "updated", {
                        title,
                        status,
                        priority,
                        assignee: existing.assignee,
                    });
                })();
                if (existing.assignee === TASK_ASSIGNEES.mira.id) {
                    void notifyMira("updated", { id, title });
                }
                return json(toFrontendTask(taskById(id) as DatabaseTask));
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_update_failed",
                    context: "tasks.update",
                    message: "Failed to update task",
                });
            }
        },

        DELETE: (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined)
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            const existing = database
                .prepare("SELECT id, title, assignee FROM tasks WHERE id = ?")
                .get(id) as
                | undefined
                | { assignee: Assignee | null | undefined; id: number; title: string };
            if (!existing)
                return routeFailureResponse({
                    context: "task",
                    message: "Task not found",
                    status: 404,
                });
            const existingAssignee = existing.assignee ?? undefined;
            try {
                database.transaction(() => {
                    database
                        .prepare("DELETE FROM task_updates WHERE task_id = ?")
                        .run(id);
                    database.prepare("DELETE FROM task_events WHERE task_id = ?").run(id);
                    database.prepare("DELETE FROM tasks WHERE id = ?").run(id);
                })();
                if (existingAssignee === TASK_ASSIGNEES.mira.id) {
                    void notifyMira("deleted", existing);
                }
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_delete_failed",
                    context: "tasks.delete",
                    message: "Failed to delete task",
                });
            }
            return json({ isOk: true } satisfies TaskMutationResponse);
        },
    },

    "/api/tasks/:id/assign": {
        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            try {
                const body = await readApiJson(request, parseAssignTaskRequest);
                if (id === undefined)
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid id",
                        status: 400,
                    });
                const assignee = body.assignee ?? undefined;
                const existing = taskById(id);
                if (!existing)
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                database.transaction(() => {
                    database
                        .prepare(
                            "UPDATE tasks SET assignee = ?, updated_at = ? WHERE id = ?"
                        )
                        .run(sqlNullable(assignee), nowIso(), id);
                    recordEvent(id, "assigned", { assignee });
                })();
                if (assignee === TASK_ASSIGNEES.mira.id) {
                    void notifyMira("assigned", { id, title: existing.title });
                }
                return json(toFrontendTask(taskById(id) as DatabaseTask));
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_assign_failed",
                    context: "tasks.assign",
                    message: "Failed to assign task",
                });
            }
        },
    },

    "/api/tasks/:id/move": {
        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            try {
                const body = await readApiJson(request, parseMoveTaskRequest);
                if (id === undefined) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid request",
                        status: 400,
                    });
                }
                const existing = taskById(id);
                if (!existing)
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                const status = body.columnLabel;
                const labels = [
                    ...labelsFromTask(existing).filter(
                        (label) =>
                            !["todo", "in-progress", "blocked", "done"].includes(label)
                    ),
                    status,
                ];
                database.transaction(() => {
                    database
                        .prepare(
                            "UPDATE tasks SET status = ?, labels_json = ?, updated_at = ? WHERE id = ?"
                        )
                        .run(status, JSON.stringify(labels), nowIso(), id);
                    recordEvent(id, "moved", { status });
                })();
                return json(toFrontendTask(taskById(id) as DatabaseTask));
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_move_failed",
                    context: "tasks.move",
                    message: "Failed to move task",
                });
            }
        },
    },

    "/api/tasks/:id/updates": {
        GET: (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined)
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            try {
                const rows = database
                    .prepare(
                        `SELECT id, task_id, author, message_md, created_at
                         FROM task_updates
                         WHERE task_id = ?
                         ORDER BY datetime(created_at) DESC, id DESC`
                    )
                    .all(id) as DatabaseTaskUpdate[];
                return json(rows.map((row) => toFrontendTaskUpdate(row)));
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_updates_list_failed",
                    context: "tasks.updates.list",
                    message: "Failed to list task updates",
                });
            }
        },

        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            try {
                const body = await readApiJson(request, parseCreateTaskUpdateRequest);
                if (id === undefined) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid update payload",
                        status: 400,
                    });
                }
                if (!database.prepare("SELECT id FROM tasks WHERE id = ?").get(id)) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                }
                const messageMd = body.messageMd.trim();
                const author = body.author;
                const createdAt = nowIso();
                const result = database.transaction(() => {
                    const insertResult = database
                        .prepare(
                            `INSERT INTO task_updates (task_id, author, message_md, created_at)
                         VALUES (?, ?, ?, ?)`
                        )
                        .run(id, author, messageMd, createdAt);
                    database
                        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
                        .run(createdAt, id);
                    return insertResult;
                })();
                const row = database
                    .prepare(
                        "SELECT id, task_id, author, message_md, created_at FROM task_updates WHERE id = ?"
                    )
                    .get(Number(result.lastInsertRowid)) as DatabaseTaskUpdate;
                const task = database
                    .prepare("SELECT title, assignee FROM tasks WHERE id = ?")
                    .get(id) as { assignee: Assignee | null | undefined; title: string };
                if ((task.assignee ?? undefined) === TASK_ASSIGNEES.mira.id) {
                    void notifyMira("progress", { id, title: task.title });
                }
                return json(toFrontendTaskUpdate(row), { status: 201 });
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_update_create_failed",
                    context: "tasks.updates.create",
                    message: "Failed to create task update",
                });
            }
        },
    },

    "/api/tasks/:id/updates/:updateId": {
        PATCH: async (request: ParametersRequest<"id" | "updateId">) => {
            const id = safeId(request.params.id);
            const updateId = safeId(request.params.updateId);
            try {
                const body = await readApiJson(request, parseUpdateTaskUpdateRequest);
                if (id === undefined || updateId === undefined) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid update payload",
                        status: 400,
                    });
                }
                const existing = database
                    .prepare("SELECT id FROM task_updates WHERE id = ? AND task_id = ?")
                    .get(updateId, id);
                if (!existing)
                    return routeFailureResponse({
                        context: "task",
                        message: "Update not found",
                        status: 404,
                    });
                const messageMd = body.messageMd.trim();
                database.transaction(() => {
                    database
                        .prepare(
                            "UPDATE task_updates SET message_md = ? WHERE id = ? AND task_id = ?"
                        )
                        .run(messageMd, updateId, id);
                    database
                        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
                        .run(nowIso(), id);
                })();
                const row = database
                    .prepare(
                        "SELECT id, task_id, author, message_md, created_at FROM task_updates WHERE id = ?"
                    )
                    .get(updateId) as DatabaseTaskUpdate;
                return json(toFrontendTaskUpdate(row));
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_update_edit_failed",
                    context: "tasks.updates.edit",
                    message: "Failed to edit task update",
                });
            }
        },

        DELETE: (request: ParametersRequest<"id" | "updateId">) => {
            const id = safeId(request.params.id);
            const updateId = safeId(request.params.updateId);
            if (id === undefined || updateId === undefined) {
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            }
            const existing = database
                .prepare("SELECT id FROM task_updates WHERE id = ? AND task_id = ?")
                .get(updateId, id);
            if (!existing)
                return routeFailureResponse({
                    context: "task",
                    message: "Update not found",
                    status: 404,
                });
            try {
                database.transaction(() => {
                    database
                        .prepare("DELETE FROM task_updates WHERE id = ? AND task_id = ?")
                        .run(updateId, id);
                    database
                        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
                        .run(nowIso(), id);
                })();
                return json({ isOk: true } satisfies TaskMutationResponse);
            } catch (error) {
                return routeErrorResponse(request, error, {
                    code: "task_update_delete_failed",
                    context: "tasks.updates.delete",
                    message: "Failed to delete task update",
                });
            }
        },
    },
} as const;
