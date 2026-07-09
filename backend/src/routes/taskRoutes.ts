import {
    TASK_ASSIGNEE_IDS,
    TASK_ASSIGNEES,
    type TaskAssigneeId,
} from "../constants/taskActors.ts";
import { database, sqlNullable } from "../database.ts";
import gateway from "../gateway.ts";
import { HttpError, json, readJson } from "../http.ts";
import { errorMessage, httpStatusCode } from "../lib/errors.ts";
import { objectFallback } from "../lib/values.ts";

type Status = "todo" | "in-progress" | "blocked" | "done";
type Assignee = TaskAssigneeId;
type ParametersRequest<T extends string> = Request & { params: Record<T, string> };
const INVALID_ASSIGNEE_MESSAGE = "Assignee not found in allowed list";

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

interface CronJob {
    id?: string;
    jobId?: string;
    name?: string;
    enabled?: boolean;
    schedule?: Record<string, unknown>;
    payload?: Record<string, unknown>;
    state?: Record<string, unknown>;
    sessionTarget?: string;
}

interface TaskAutomationInput {
    type?: string;
    recurring?: boolean;
    cronJobId?: string;
    scheduleSummary?: string;
    sessionTarget?: string;
    model?: string;
    thinking?: string;
    [key: string]: unknown;
}

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

function isValidAssignee(value: unknown): value is Assignee {
    return typeof value === "string" && TASK_ASSIGNEE_IDS.includes(value as Assignee);
}

function normalizeStatus(columnLabel?: string): Status | undefined {
    if (columnLabel === "done") return "done";
    if (columnLabel === "blocked") return "blocked";
    if (columnLabel === "in-progress") return "in-progress";
    if (columnLabel === "todo") return "todo";
    return undefined;
}

function derivePriority(labels: string[]): "low" | "medium" | "high" {
    if (labels.includes("priority-high") || labels.includes("high")) return "high";
    if (labels.includes("priority-low") || labels.includes("low")) return "low";
    return "medium";
}

function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
        throw new HttpError(`${field} must be a string`, 400);
    }
    return value;
}

function optionalLabels(value: unknown): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
        throw new HttpError("Labels must be an array of strings", 400);
    }
    return value;
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

function normalizeAutomationInput(value: unknown): string {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return "{}";
    }
    const input = value as TaskAutomationInput;
    const cronJobId = typeof input.cronJobId === "string" ? input.cronJobId.trim() : "";
    if (!cronJobId) return "{}";
    const automation: TaskAutomationInput = {
        type: "cron",
        recurring: input.recurring ?? true,
        cronJobId,
    };
    for (const key of ["scheduleSummary", "sessionTarget", "model", "thinking"]) {
        const keyValue = input[key];
        if (typeof keyValue === "string" && keyValue.trim()) {
            automation[key] = keyValue.trim();
        }
    }
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
    return String(schedule.kind || "Scheduled");
}

function cronJobId(job: CronJob): string {
    return String(job.jobId || job.id || "");
}

async function fetchCronJobsById(): Promise<Map<string, CronJob>> {
    try {
        const payload = await gateway.request("cron.list", { includeDisabled: true });
        if (!payload || typeof payload !== "object") return new Map();
        const value = payload as { jobs?: CronJob[]; items?: CronJob[] };
        const jobs = Array.isArray(value.jobs)
            ? value.jobs
            : Array.isArray(value.items)
              ? value.items
              : [];
        return new Map(
            jobs
                .map((job) => [cronJobId(job), job] as const)
                .filter(([id]) => id.length > 0)
        );
    } catch {
        return new Map();
    }
}

function toFrontendAutomation(task: DatabaseTask, cronJobsById?: Map<string, CronJob>) {
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

function toFrontendTask(task: DatabaseTask, cronJobsById?: Map<string, CronJob>) {
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

function toFrontendTaskUpdate(update: DatabaseTaskUpdate) {
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

function miraTaskNotificationMessage(
    eventType: string,
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

async function notifyMira(eventType: string, task: { id: number; title: string }) {
    try {
        await gateway.sendSessionMessage(
            "main",
            miraTaskNotificationMessage(eventType, task)
        );
    } catch (error) {
        console.error("[Tasks] Failed to notify Mira:", error);
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

async function readTaskJson<T>(request: Request): Promise<T | Response> {
    try {
        const body = await readJson<T>(request);
        if (!body || typeof body !== "object" || Array.isArray(body)) {
            return json({ error: "Request body must be an object" }, { status: 400 });
        }
        return body;
    } catch (error) {
        return json(
            { error: errorMessage(error, "Invalid JSON") },
            { status: httpStatusCode(error) }
        );
    }
}

function taskRouteError(error: unknown, fallback = "Invalid task payload"): Response {
    return json(
        { error: errorMessage(error, fallback) },
        { status: httpStatusCode(error) }
    );
}

export const taskRoutes = {
    "/api/tasks": {
        GET: async () => {
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
                console.error("[Tasks] Failed to list tasks:", error);
                return json({ error: "Failed to list tasks" }, { status: 500 });
            }
        },

        POST: async (request: Request) => {
            const body = await readTaskJson<{
                assignee?: Assignee | undefined;
                automation?: TaskAutomationInput;
                body?: string;
                labels?: string[];
                title?: string;
            }>(request);
            if (body instanceof Response) return body;
            try {
                const title = optionalString(body.title, "Title")?.trim();
                if (!title) return json({ error: "Title is required" }, { status: 400 });
                if (
                    body.assignee !== undefined &&
                    body.assignee !== null &&
                    !isValidAssignee(body.assignee)
                ) {
                    return json({ error: INVALID_ASSIGNEE_MESSAGE }, { status: 400 });
                }
                const assignee = body.assignee ?? undefined;
                const now = nowIso();
                const labels = optionalLabels(body.labels) ?? [];
                const taskBody = optionalString(body.body, "Body") ?? "";
                const status =
                    normalizeStatus(
                        labels.includes("done")
                            ? "done"
                            : labels.includes("blocked")
                              ? "blocked"
                              : labels.includes("in-progress")
                                ? "in-progress"
                                : "todo"
                    ) ?? "todo";
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
                return taskRouteError(error);
            }
        },
    },

    "/api/tasks/:id": {
        GET: async (request: ParametersRequest<"id">) => {
            try {
                const id = safeId(request.params.id);
                if (id === undefined)
                    return json({ error: "Invalid id" }, { status: 400 });
                const row = taskById(id);
                if (!row) return json({ error: "Task not found" }, { status: 404 });
                return json(toFrontendTask(row, await fetchCronJobsById()));
            } catch (error) {
                return taskRouteError(error);
            }
        },

        PATCH: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined) return json({ error: "Invalid id" }, { status: 400 });
            const existing = taskById(id);
            if (!existing) return json({ error: "Task not found" }, { status: 404 });
            const body = await readTaskJson<{
                automation?: TaskAutomationInput | undefined;
                body?: string;
                labels?: string[];
                title?: string;
            }>(request);
            if (body instanceof Response) return body;
            try {
                const labels = optionalLabels(body.labels) ?? labelsFromTask(existing);
                const status =
                    normalizeStatus(
                        labels.includes("done")
                            ? "done"
                            : labels.includes("blocked")
                              ? "blocked"
                              : labels.includes("in-progress")
                                ? "in-progress"
                                : "todo"
                    ) ?? "todo";
                const priority = derivePriority(labels);
                const title =
                    optionalString(body.title, "Title")?.trim() || existing.title;
                const taskBody = optionalString(body.body, "Body") ?? existing.body;
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
                return taskRouteError(error);
            }
        },

        DELETE: (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined) return json({ error: "Invalid id" }, { status: 400 });
            const existing = database
                .prepare("SELECT id, title, assignee FROM tasks WHERE id = ?")
                .get(id) as
                | undefined
                | { assignee: Assignee | null | undefined; id: number; title: string };
            if (!existing) return json({ error: "Task not found" }, { status: 404 });
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
                console.error("[Tasks] Failed to delete task:", error);
                return json({ error: "Failed to delete task" }, { status: 500 });
            }
            return json({ isOk: true });
        },
    },

    "/api/tasks/:id/assign": {
        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            const body = await readTaskJson<{ assignee?: string | null | undefined }>(
                request
            );
            if (body instanceof Response) return body;
            if (id === undefined) return json({ error: "Invalid id" }, { status: 400 });
            if (
                body.assignee !== undefined &&
                body.assignee !== null &&
                !isValidAssignee(body.assignee)
            ) {
                return json({ error: INVALID_ASSIGNEE_MESSAGE }, { status: 400 });
            }
            const assignee = body.assignee ?? undefined;
            const existing = taskById(id);
            if (!existing) return json({ error: "Task not found" }, { status: 404 });
            try {
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
                console.error("[Tasks] Failed to assign task:", error);
                return json({ error: "Failed to assign task" }, { status: 500 });
            }
        },
    },

    "/api/tasks/:id/move": {
        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            const body = await readTaskJson<{ columnLabel?: string }>(request);
            if (body instanceof Response) return body;
            try {
                const columnLabel = optionalString(body.columnLabel, "Column label");
                if (id === undefined || !columnLabel) {
                    return json({ error: "Invalid request" }, { status: 400 });
                }
                const existing = taskById(id);
                if (!existing) return json({ error: "Task not found" }, { status: 404 });
                const status = normalizeStatus(columnLabel);
                if (!status) {
                    return json({ error: "Invalid task status" }, { status: 400 });
                }
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
                return taskRouteError(error);
            }
        },
    },

    "/api/tasks/:id/updates": {
        GET: (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined) return json({ error: "Invalid id" }, { status: 400 });
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
                return taskRouteError(error);
            }
        },

        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            const body = await readTaskJson<{ author?: Assignee; messageMd?: string }>(
                request
            );
            if (body instanceof Response) return body;
            try {
                const messageMd = optionalString(body.messageMd, "Message")?.trim();
                if (id === undefined || !isValidAssignee(body.author) || !messageMd) {
                    return json({ error: "Invalid update payload" }, { status: 400 });
                }
                if (!database.prepare("SELECT id FROM tasks WHERE id = ?").get(id)) {
                    return json({ error: "Task not found" }, { status: 404 });
                }
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
                return taskRouteError(error);
            }
        },
    },

    "/api/tasks/:id/updates/:updateId": {
        PATCH: async (request: ParametersRequest<"id" | "updateId">) => {
            const id = safeId(request.params.id);
            const updateId = safeId(request.params.updateId);
            const body = await readTaskJson<{ messageMd?: string }>(request);
            if (body instanceof Response) return body;
            try {
                const messageMd = optionalString(body.messageMd, "Message")?.trim();
                if (id === undefined || updateId === undefined || !messageMd) {
                    return json({ error: "Invalid update payload" }, { status: 400 });
                }
                const existing = database
                    .prepare("SELECT id FROM task_updates WHERE id = ? AND task_id = ?")
                    .get(updateId, id);
                if (!existing)
                    return json({ error: "Update not found" }, { status: 404 });
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
                return taskRouteError(error);
            }
        },

        DELETE: (request: ParametersRequest<"id" | "updateId">) => {
            const id = safeId(request.params.id);
            const updateId = safeId(request.params.updateId);
            if (id === undefined || updateId === undefined) {
                return json({ error: "Invalid id" }, { status: 400 });
            }
            const existing = database
                .prepare("SELECT id FROM task_updates WHERE id = ? AND task_id = ?")
                .get(updateId, id);
            if (!existing) return json({ error: "Update not found" }, { status: 404 });
            try {
                database.transaction(() => {
                    database
                        .prepare("DELETE FROM task_updates WHERE id = ? AND task_id = ?")
                        .run(updateId, id);
                    database
                        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
                        .run(nowIso(), id);
                })();
                return json({ isOk: true });
            } catch (error) {
                return taskRouteError(error);
            }
        },
    },
} as const;
