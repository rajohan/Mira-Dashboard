import {
    parseCreateTaskUpdateRequest,
    parseUpdateTaskUpdateRequest,
    TASK_ASSIGNEES,
    type TaskMutationResponse,
} from "../../../../contracts/tasks.ts";
import { database } from "../../database/connection.ts";
import { json } from "../../http/core.ts";
import {
    type ParametersRequest,
    readApiJson,
    routeErrorResponse,
    routeFailureResponse,
} from "../../http/routeSupport.ts";
import {
    type DatabaseTask,
    type DatabaseTaskUpdate,
    nowIso,
    safeId,
    taskById,
    toFrontendTaskUpdate,
} from "./model.ts";
import { notifyMira } from "./notifications.ts";

function miraAssignedTask(id: number): DatabaseTask | undefined {
    const task = taskById(id);
    return task?.assignee === TASK_ASSIGNEES.mira.id ? task : undefined;
}

export const taskUpdateRoutes = {
    "/api/tasks/:id/updates": {
        GET: (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            if (id === undefined) {
                return routeFailureResponse({
                    context: "task",
                    message: "Invalid id",
                    status: 400,
                });
            }
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
                const task = taskById(id);
                if (!task) {
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
                if (task.assignee === TASK_ASSIGNEES.mira.id) {
                    void notifyMira("comment-added", { id, title: task.title });
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
                if (!existing) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Update not found",
                        status: 404,
                    });
                }
                const notificationTask = miraAssignedTask(id);
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
                if (notificationTask) {
                    void notifyMira("comment-edited", {
                        id,
                        title: notificationTask.title,
                    });
                }
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
            if (!existing) {
                return routeFailureResponse({
                    context: "task",
                    message: "Update not found",
                    status: 404,
                });
            }
            const notificationTask = miraAssignedTask(id);
            try {
                database.transaction(() => {
                    database
                        .prepare("DELETE FROM task_updates WHERE id = ? AND task_id = ?")
                        .run(updateId, id);
                    database
                        .prepare("UPDATE tasks SET updated_at = ? WHERE id = ?")
                        .run(nowIso(), id);
                })();
                if (notificationTask) {
                    void notifyMira("comment-deleted", {
                        id,
                        title: notificationTask.title,
                    });
                }
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
