import {
    parseCreateTaskRequest,
    parseUpdateTaskRequest,
    TASK_ASSIGNEES,
    type TaskMutationResponse,
} from "../../../../contracts/tasks.ts";
import { database, sqlNullable } from "../../database/connection.ts";
import { json } from "../../http/core.ts";
import {
    type ParametersRequest,
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../../http/routeSupport.ts";
import {
    type Assignee,
    type DatabaseTask,
    type DatabaseTaskRow,
    derivePriority,
    deriveStatus,
    fetchCronJobsById,
    labelsFromTask,
    normalizeAutomationInput,
    normalizeDatabaseTasks,
    nowIso,
    recordEvent,
    safeId,
    taskById,
    toFrontendTask,
} from "./model.ts";
import { notifyMira } from "./notifications.ts";

export const taskCrudRoutes = {
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
                if (id === undefined) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid id",
                        status: 400,
                    });
                }
                const row = taskById(id);
                if (!row) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                }
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
            if (id === undefined) {
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            }
            const existing = taskById(id);
            if (!existing) {
                return routeFailureResponse({
                    context: "task",
                    message: "Task not found",
                    status: 404,
                });
            }
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
            if (id === undefined) {
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            }
            const existing = database
                .prepare("SELECT id, title, assignee FROM tasks WHERE id = ?")
                .get(id) as
                | undefined
                | { assignee: Assignee | null | undefined; id: number; title: string };
            if (!existing) {
                return routeFailureResponse({
                    context: "task",
                    message: "Task not found",
                    status: 404,
                });
            }
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
} as const;
