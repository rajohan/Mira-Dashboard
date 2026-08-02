import {
    parseAssignTaskRequest,
    parseMoveTaskRequest,
    TASK_ASSIGNEES,
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
    type DatabaseTask,
    labelsFromTask,
    nowIso,
    recordEvent,
    safeId,
    taskById,
    toFrontendTask,
} from "./model.ts";
import { notifyMira } from "./notifications.ts";

export const taskWorkflowRoutes = {
    "/api/tasks/:id/assign": {
        POST: async (request: ParametersRequest<"id">) => {
            const id = safeId(request.params.id);
            try {
                const body = await readApiJson(request, parseAssignTaskRequest);
                if (id === undefined) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Invalid id",
                        status: 400,
                    });
                }
                const assignee = body.assignee ?? undefined;
                const existing = taskById(id);
                if (!existing) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                }
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
                if (!existing) {
                    return routeFailureResponse({
                        context: "task",
                        message: "Task not found",
                        status: 404,
                    });
                }
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
} as const;
