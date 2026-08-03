import { afterEach, describe, expect, it, jest } from "bun:test";
import {
    chmodSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { database } from "../../src/database/connection.ts";
import { runWithRequestAuditContext } from "../../src/http/requestAuditContext.ts";
import { CONFIG_REDACTION_SENTINEL } from "../../src/services/configRedaction.ts";
import { apiErrorExpectation } from "../support/apiErrorExpectation.ts";
const cleanupCallbacks: Array<() => Promise<void> | void> = [];
function rememberEnvironment(key: string): void {
    const originalValue = process.env[key];
    cleanupCallbacks.push(() => {
        if (originalValue === undefined) {
            delete process.env[key];
        } else {
            process.env[key] = originalValue;
        }
    });
}
function createTemporaryRoot(prefix: string): string {
    const root = mkdtempSync(path.join(tmpdir(), prefix));
    cleanupCallbacks.push(() =>
        rmSync(root, {
            force: true,
            recursive: true,
        })
    );
    return root;
}
function isolateOpenClawEnvironment(prefix: string): void {
    rememberEnvironment("OPENCLAW_HOME");
    rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
    const root = createTemporaryRoot(prefix);
    process.env.OPENCLAW_HOME = path.join(root, "openclaw-home");
    process.env.MIRA_DASHBOARD_OPENCLAW_HOME = path.join(root, "dashboard-home");
}
function requestWithParameters<T extends string>(
    route: string,
    parameters: Record<T, string>,
    init?: RequestInit
): Request & {
    params: Record<T, string>;
} {
    return Object.assign(new Request(`https://test.local${route}`, init), {
        params: parameters,
    });
}
function jsonRequest(route: string, body: unknown): Request {
    return new Request(`https://test.local${route}`, {
        body: JSON.stringify(body),
        headers: {
            "Content-Type": "application/json",
        },
        method: "POST",
    });
}
async function responseJson(response: Response): Promise<Record<string, unknown>> {
    return (await response.json()) as Record<string, unknown>;
}
function runAsMiraTaskTracking<Result>(
    requestId: string,
    operation: () => Result
): Result {
    return runWithRequestAuditContext(
        {
            actor: {
                id: "openclaw-task-tracking",
                type: "automation",
            },
            requestId,
        },
        operation
    );
}
afterEach(async () => {
    while (cleanupCallbacks.length > 0) await cleanupCallbacks.pop()?.();
    database
        .prepare(
            "DELETE FROM task_updates WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database
        .prepare(
            "DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE title LIKE 'Coverage %')"
        )
        .run();
    database.prepare("DELETE FROM tasks WHERE title LIKE 'Coverage %'").run();
    database
        .prepare(
            "DELETE FROM openclaw_cron_job_metadata WHERE job_id LIKE 'coverage-%' OR job_id = 'item-cron'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM notifications WHERE dedupe_key LIKE 'quota:%' OR dedupe_key LIKE 'openclaw:%'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM quota_alert_state WHERE provider IN ('openrouter', 'elevenlabs', 'synthetic', 'openai')"
        )
        .run();
    database.prepare("DELETE FROM openclaw_alert_state WHERE id = 1").run();
    database
        .prepare(
            "DELETE FROM scheduled_job_runs WHERE job_id LIKE 'cache.%' OR job_id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM scheduled_jobs WHERE id LIKE 'cache.%' OR id = 'notifications.openclaw'"
        )
        .run();
    database
        .prepare(
            "DELETE FROM cache_entries WHERE key IN ('quotas.summary', 'system.host', 'system.openclaw', 'git.workspace', 'backup.kopia.status', 'backup.walg.status', 'log_rotation.state', 'weather.spydeberg')"
        )
        .run();
    database.prepare("DELETE FROM cache_entries WHERE key LIKE 'moltbook.%'").run();
    database
        .prepare(
            "DELETE FROM auth_sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'coverage-%')"
        )
        .run();
    database.prepare("DELETE FROM auth_rate_limit_buckets").run();
    database.prepare("DELETE FROM users WHERE username LIKE 'coverage-%'").run();
});
describe("backend core resource routes", () => {
    it("task route automation, validation, assignment, movement, updates, and deletion", async () => {
        isolateOpenClawEnvironment("mira-task-route-coverage-");
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        const originalRequest = gateway.request;
        const originalSendSessionMessage = gateway.sendSessionMessage;
        cleanupCallbacks.push(() => {
            gateway.request = originalRequest;
            gateway.sendSessionMessage = originalSendSessionMessage;
        });
        const taskNotifications: string[] = [];
        gateway.request = () =>
            Promise.try(() => ({
                jobs: [
                    {
                        enabled: true,
                        id: "cron-unit",
                        name: "Coverage cron",
                        payload: {
                            model: "codex",
                            thinking: "high",
                        },
                        schedule: {
                            everyMs: 3_600_000,
                            kind: "every",
                        },
                        sessionTarget: "agent:main:main",
                        state: {
                            lastDurationMs: 42,
                            lastRunStatus: "success",
                        },
                    },
                ],
            }));
        gateway.sendSessionMessage = (_sessionKey, message) => {
            return Promise.try(() => {
                taskNotifications.push(message);
            });
        };
        const { taskRoutes } = await import("../../src/routes/taskRoutes/handlers.ts");
        const invalidCreate = await taskRoutes["/api/tasks"].POST(
            jsonRequest("/api/tasks", {
                labels: "bug",
                title: "Coverage invalid",
            })
        );
        expect(invalidCreate.status).toBe(400);
        const create = await taskRoutes["/api/tasks"].POST(
            jsonRequest("/api/tasks", {
                automation: {
                    cronJobId: "cron-unit",
                    model: "stored-model",
                    scheduleSummary: "stored schedule",
                },
                body: "Body",
                labels: ["blocked", "priority-high"],
                title: "Coverage route task",
            })
        );
        expect(create.status).toBe(201);
        const created = await responseJson(create);
        const id = Number(created.number);
        expect(created).toMatchObject({
            automation: {
                cronJobId: "cron-unit",
                model: "stored-model",
                scheduleSummary: "stored schedule",
                source: "stored",
            },
            state: "OPEN",
            title: "Coverage route task",
        });
        const notificationCount = taskNotifications.length;
        const automatedCreate = await runWithRequestAuditContext(
            {
                actor: {
                    id: "task-automation-test",
                    type: "automation",
                },
                requestId: "task-automation-request",
            },
            () =>
                taskRoutes["/api/tasks"].POST(
                    jsonRequest("/api/tasks", {
                        assignee: "mira-2026",
                        labels: ["todo"],
                        title: "Automation task must not enter chat",
                    })
                )
        );
        const automatedTask = await responseJson(automatedCreate);
        const automatedTaskNumber = Number(automatedTask.number);
        expect(taskNotifications).toHaveLength(notificationCount + 1);
        expect(taskNotifications.at(-1)).toBe(
            `Task created: #${automatedTaskNumber}. A scoped automation created this Mira task; review it in Dashboard when the current work is clear.`
        );
        expect(taskNotifications.at(-1)).not.toContain(
            "Automation task must not enter chat"
        );
        runWithRequestAuditContext(
            {
                actor: {
                    id: "task-automation-test",
                    type: "automation",
                },
                requestId: "task-automation-cleanup",
            },
            () =>
                taskRoutes["/api/tasks/:id"].DELETE(
                    requestWithParameters(`/api/tasks/${automatedTaskNumber}`, {
                        id: String(automatedTaskNumber),
                    })
                )
        );
        expect(taskNotifications).toHaveLength(notificationCount + 2);
        expect(taskNotifications.at(-1)).toBe(
            `Task deleted: #${automatedTaskNumber}. A scoped automation deleted this Mira task; review it in Dashboard when the current work is clear.`
        );
        const notificationCountBeforeMiraAutomation = taskNotifications.length;
        const miraAutomationTaskCreate = await runAsMiraTaskTracking(
            "mira-task-tracking-create",
            () =>
                taskRoutes["/api/tasks"].POST(
                    jsonRequest("/api/tasks", {
                        assignee: "mira-2026",
                        labels: ["todo"],
                        title: "Mira automation notification coverage",
                    })
                )
        );
        expect(miraAutomationTaskCreate.status).toBe(201);
        const miraAutomationTask = await responseJson(miraAutomationTaskCreate);
        const miraAutomationTaskNumber = Number(miraAutomationTask.number);
        expect(taskNotifications).toHaveLength(notificationCountBeforeMiraAutomation);
        const assignRaymondResponse = await runAsMiraTaskTracking(
            "mira-task-tracking-assign-raymond",
            () =>
                taskRoutes["/api/tasks/:id/assign"].POST(
                    requestWithParameters(
                        `/api/tasks/${miraAutomationTaskNumber}/assign`,
                        {
                            id: String(miraAutomationTaskNumber),
                        },
                        {
                            body: JSON.stringify({
                                assignee: "rajohan",
                            }),
                            method: "POST",
                        }
                    )
                )
        );
        expect(assignRaymondResponse.status).toBe(200);
        const assignMiraResponse = await runAsMiraTaskTracking(
            "mira-task-tracking-assign-mira",
            () =>
                taskRoutes["/api/tasks/:id/assign"].POST(
                    requestWithParameters(
                        `/api/tasks/${miraAutomationTaskNumber}/assign`,
                        {
                            id: String(miraAutomationTaskNumber),
                        },
                        {
                            body: JSON.stringify({
                                assignee: "mira-2026",
                            }),
                            method: "POST",
                        }
                    )
                )
        );
        expect(assignMiraResponse.status).toBe(200);
        const patchResponse = await runAsMiraTaskTracking(
            "mira-task-tracking-patch",
            () =>
                taskRoutes["/api/tasks/:id"].PATCH(
                    requestWithParameters(
                        `/api/tasks/${miraAutomationTaskNumber}`,
                        {
                            id: String(miraAutomationTaskNumber),
                        },
                        {
                            body: JSON.stringify({
                                labels: ["done"],
                                title: "Mira automation notification coverage updated",
                            }),
                            method: "PATCH",
                        }
                    )
                )
        );
        expect(patchResponse.status).toBe(200);
        const moveResponse = await runAsMiraTaskTracking("mira-task-tracking-move", () =>
            taskRoutes["/api/tasks/:id/move"].POST(
                requestWithParameters(
                    `/api/tasks/${miraAutomationTaskNumber}/move`,
                    {
                        id: String(miraAutomationTaskNumber),
                    },
                    {
                        body: JSON.stringify({
                            columnLabel: "in-progress",
                        }),
                        method: "POST",
                    }
                )
            )
        );
        expect(moveResponse.status).toBe(200);
        const commentResponse = await runAsMiraTaskTracking(
            "mira-task-tracking-comment-add",
            () =>
                taskRoutes["/api/tasks/:id/updates"].POST(
                    requestWithParameters(
                        `/api/tasks/${miraAutomationTaskNumber}/updates`,
                        {
                            id: String(miraAutomationTaskNumber),
                        },
                        {
                            body: JSON.stringify({
                                author: "rajohan",
                                messageMd: "Payload author must not override the actor",
                            }),
                            method: "POST",
                        }
                    )
                )
        );
        expect(commentResponse.status).toBe(201);
        const comment = await responseJson(commentResponse);
        const commentId = Number(comment.id);
        const editCommentResponse = await runAsMiraTaskTracking(
            "mira-task-tracking-comment-edit",
            () =>
                taskRoutes["/api/tasks/:id/updates/:updateId"].PATCH(
                    requestWithParameters(
                        `/api/tasks/${miraAutomationTaskNumber}/updates/${commentId}`,
                        {
                            id: String(miraAutomationTaskNumber),
                            updateId: String(commentId),
                        },
                        {
                            body: JSON.stringify({
                                messageMd: "Edited by Mira",
                            }),
                            method: "PATCH",
                        }
                    )
                )
        );
        expect(editCommentResponse.status).toBe(200);
        const deleteCommentResponse = runAsMiraTaskTracking(
            "mira-task-tracking-comment-delete",
            () =>
                taskRoutes["/api/tasks/:id/updates/:updateId"].DELETE(
                    requestWithParameters(
                        `/api/tasks/${miraAutomationTaskNumber}/updates/${commentId}`,
                        {
                            id: String(miraAutomationTaskNumber),
                            updateId: String(commentId),
                        }
                    )
                )
        );
        expect(deleteCommentResponse.status).toBe(200);
        const deleteResponse = runAsMiraTaskTracking("mira-task-tracking-delete", () =>
            taskRoutes["/api/tasks/:id"].DELETE(
                requestWithParameters(`/api/tasks/${miraAutomationTaskNumber}`, {
                    id: String(miraAutomationTaskNumber),
                })
            )
        );
        expect(deleteResponse.status).toBe(200);
        expect(taskNotifications).toHaveLength(notificationCountBeforeMiraAutomation);
        const enriched = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters(`/api/tasks/${id}`, {
                id: String(id),
            })
        );
        expect(enriched.json()).resolves.toMatchObject({
            automation: {
                enabled: true,
                model: "codex",
                scheduleSummary: "Every 1h",
                source: "cron",
            },
        });
        const getInvalid = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters("/api/tasks/not-a-number", {
                id: "not-a-number",
            })
        );
        expect(getInvalid.status).toBe(400);
        const missingId = 2_147_483_647;
        const getMissing = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters(`/api/tasks/${missingId}`, {
                id: String(missingId),
            })
        );
        expect(getMissing.status).toBe(404);
        const patchInvalidId = await taskRoutes["/api/tasks/:id"].PATCH(
            requestWithParameters(
                "/api/tasks/invalid",
                {
                    id: "invalid",
                },
                {
                    body: JSON.stringify({
                        title: "Ignored",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(patchInvalidId.status).toBe(400);
        const patchMissing = await taskRoutes["/api/tasks/:id"].PATCH(
            requestWithParameters(
                `/api/tasks/${missingId}`,
                {
                    id: String(missingId),
                },
                {
                    body: JSON.stringify({
                        title: "Missing",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(patchMissing.status).toBe(404);
        const deleteInvalidId = taskRoutes["/api/tasks/:id"].DELETE(
            requestWithParameters("/api/tasks/invalid", {
                id: "invalid",
            })
        );
        expect(deleteInvalidId.status).toBe(400);
        const deleteMissing = taskRoutes["/api/tasks/:id"].DELETE(
            requestWithParameters(`/api/tasks/${missingId}`, {
                id: String(missingId),
            })
        );
        expect(deleteMissing.status).toBe(404);
        const assignInvalidId = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                "/api/tasks/invalid/assign",
                {
                    id: "invalid",
                },
                {
                    body: JSON.stringify({
                        assignee: "mira-2026",
                    }),
                    method: "POST",
                }
            )
        );
        expect(assignInvalidId.status).toBe(400);
        const assignMissing = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${missingId}/assign`,
                {
                    id: String(missingId),
                },
                {
                    body: JSON.stringify({
                        assignee: "mira-2026",
                    }),
                    method: "POST",
                }
            )
        );
        expect(assignMissing.status).toBe(404);
        const moveInvalidId = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                "/api/tasks/invalid/move",
                {
                    id: "invalid",
                },
                {
                    body: JSON.stringify({
                        columnLabel: "todo",
                    }),
                    method: "POST",
                }
            )
        );
        expect(moveInvalidId.status).toBe(400);
        const moveMissing = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${missingId}/move`,
                {
                    id: String(missingId),
                },
                {
                    body: JSON.stringify({
                        columnLabel: "todo",
                    }),
                    method: "POST",
                }
            )
        );
        expect(moveMissing.status).toBe(404);
        const listUpdatesInvalidId = taskRoutes["/api/tasks/:id/updates"].GET(
            requestWithParameters("/api/tasks/invalid/updates", {
                id: "invalid",
            })
        );
        expect(listUpdatesInvalidId.status).toBe(400);
        const createUpdateInvalidId = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                "/api/tasks/invalid/updates",
                {
                    id: "invalid",
                },
                {
                    body: JSON.stringify({
                        author: "mira-2026",
                        messageMd: "Ignored",
                    }),
                    method: "POST",
                }
            )
        );
        expect(createUpdateInvalidId.status).toBe(400);
        const createUpdateMissing = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${missingId}/updates`,
                {
                    id: String(missingId),
                },
                {
                    body: JSON.stringify({
                        author: "mira-2026",
                        messageMd: "Missing",
                    }),
                    method: "POST",
                }
            )
        );
        expect(createUpdateMissing.status).toBe(404);
        const editUpdateInvalidIds = await taskRoutes[
            "/api/tasks/:id/updates/:updateId"
        ].PATCH(
            requestWithParameters(
                "/api/tasks/invalid/updates/invalid",
                {
                    id: "invalid",
                    updateId: "invalid",
                },
                {
                    body: JSON.stringify({
                        messageMd: "Ignored",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(editUpdateInvalidIds.status).toBe(400);
        const editUpdateMissing = await taskRoutes[
            "/api/tasks/:id/updates/:updateId"
        ].PATCH(
            requestWithParameters(
                `/api/tasks/${id}/updates/${missingId}`,
                {
                    id: String(id),
                    updateId: String(missingId),
                },
                {
                    body: JSON.stringify({
                        messageMd: "Missing",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(editUpdateMissing.status).toBe(404);
        const deleteUpdateInvalidIds = taskRoutes[
            "/api/tasks/:id/updates/:updateId"
        ].DELETE(
            requestWithParameters("/api/tasks/invalid/updates/invalid", {
                id: "invalid",
                updateId: "invalid",
            })
        );
        expect(deleteUpdateInvalidIds.status).toBe(400);
        const deleteUpdateMissing = taskRoutes["/api/tasks/:id/updates/:updateId"].DELETE(
            requestWithParameters(`/api/tasks/${id}/updates/${missingId}`, {
                id: String(id),
                updateId: String(missingId),
            })
        );
        expect(deleteUpdateMissing.status).toBe(404);
        const patch = await taskRoutes["/api/tasks/:id"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        automation: null,
                        labels: ["done", "priority-low"],
                        title: "Coverage route task updated",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(patch.json()).resolves.toMatchObject({
            state: "CLOSED",
            title: "Coverage route task updated",
        });
        const invalidAssign = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        assignee: "nobody",
                    }),
                    method: "POST",
                }
            )
        );
        expect(invalidAssign.status).toBe(400);
        const assign = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        assignee: "mira-2026",
                    }),
                    method: "POST",
                }
            )
        );
        expect(assign.json()).resolves.toMatchObject({
            assignees: [
                {
                    login: "mira-2026",
                    name: "mira-2026",
                },
            ],
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task assigned: #${id} Coverage route task updated → mira-2026. This Mira task's assignment changed; review it in Dashboard when the current work is clear.`
        );
        rememberEnvironment("MIRA_DASHBOARD_DEV_SAFE_MODE");
        const previousDevelopmentSafeMode = process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
        process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = "1";
        const notificationsBeforeIsolatedUpdate = taskNotifications.length;
        const isolatedPatch = await taskRoutes["/api/tasks/:id"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        title: "Coverage route task updated",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(isolatedPatch.status).toBe(200);
        expect(taskNotifications).toHaveLength(notificationsBeforeIsolatedUpdate);
        if (previousDevelopmentSafeMode === undefined) {
            delete process.env.MIRA_DASHBOARD_DEV_SAFE_MODE;
        } else {
            process.env.MIRA_DASHBOARD_DEV_SAFE_MODE = previousDevelopmentSafeMode;
        }
        const assignAway = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        assignee: "rajohan",
                    }),
                    method: "POST",
                }
            )
        );
        expect(assignAway.status).toBe(200);
        expect(taskNotifications.at(-1)).toBe(
            `Task assigned: #${id} Coverage route task updated → rajohan. This Mira task's assignment changed; review it in Dashboard when the current work is clear.`
        );
        const assignBack = await taskRoutes["/api/tasks/:id/assign"].POST(
            requestWithParameters(
                `/api/tasks/${id}/assign`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        assignee: "mira-2026",
                    }),
                    method: "POST",
                }
            )
        );
        expect(assignBack.status).toBe(200);
        expect(taskNotifications.at(-1)).toBe(
            `Task assigned: #${id} Coverage route task updated → mira-2026. This Mira task's assignment changed; review it in Dashboard when the current work is clear.`
        );
        const invalidMove = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${id}/move`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        columnLabel: "icebox",
                    }),
                    method: "POST",
                }
            )
        );
        expect(invalidMove.status).toBe(400);
        const move = await taskRoutes["/api/tasks/:id/move"].POST(
            requestWithParameters(
                `/api/tasks/${id}/move`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        columnLabel: "in-progress",
                    }),
                    method: "POST",
                }
            )
        );
        expect(move.json()).resolves.toMatchObject({
            state: "OPEN",
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task moved: #${id} Coverage route task updated → in-progress. This Mira task moved columns; review it in Dashboard when the current work is clear.`
        );
        const invalidUpdate = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${id}/updates`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        author: "mira-2026",
                        messageMd: "",
                    }),
                    method: "POST",
                }
            )
        );
        expect(invalidUpdate.status).toBe(400);
        const update = await taskRoutes["/api/tasks/:id/updates"].POST(
            requestWithParameters(
                `/api/tasks/${id}/updates`,
                {
                    id: String(id),
                },
                {
                    body: JSON.stringify({
                        author: "mira-2026",
                        messageMd: "Progress update",
                    }),
                    method: "POST",
                }
            )
        );
        expect(update.status).toBe(201);
        const updateBody = await responseJson(update);
        const updateId = Number(updateBody.id);
        expect(updateBody).toMatchObject({
            author: "mira-2026",
            messageMd: "Progress update",
            taskId: id,
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task comment added: #${id} Coverage route task updated. A comment was added to this Mira task; review it in Dashboard when the current work is clear.`
        );
        expect(typeof updateBody.createdAt).toBe("string");
        const listedUpdates = taskRoutes["/api/tasks/:id/updates"].GET(
            requestWithParameters(`/api/tasks/${id}/updates`, {
                id: String(id),
            })
        );
        expect(listedUpdates.json()).resolves.toContainEqual({
            ...updateBody,
            id: updateId,
        });
        const taskAfterProgress = await taskRoutes["/api/tasks/:id"].GET(
            requestWithParameters(`/api/tasks/${id}`, {
                id: String(id),
            })
        );
        expect(taskAfterProgress.json()).resolves.toMatchObject({
            updatedAt: updateBody.createdAt,
        });
        const patchUpdate = await taskRoutes["/api/tasks/:id/updates/:updateId"].PATCH(
            requestWithParameters(
                `/api/tasks/${id}/updates/${updateId}`,
                {
                    id: String(id),
                    updateId: String(updateId),
                },
                {
                    body: JSON.stringify({
                        messageMd: "Raymond update",
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(patchUpdate.json()).resolves.toMatchObject({
            author: "mira-2026",
            messageMd: "Raymond update",
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task comment edited: #${id} Coverage route task updated. A comment on this Mira task was edited; review it in Dashboard when the current work is clear.`
        );
        const deleteUpdate = taskRoutes["/api/tasks/:id/updates/:updateId"].DELETE(
            requestWithParameters(`/api/tasks/${id}/updates/${updateId}`, {
                id: String(id),
                updateId: String(updateId),
            })
        );
        expect(await responseJson(deleteUpdate)).toEqual({
            isOk: true,
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task comment deleted: #${id} Coverage route task updated. A comment on this Mira task was deleted; review it in Dashboard when the current work is clear.`
        );
        const deleteTask = taskRoutes["/api/tasks/:id"].DELETE(
            requestWithParameters(`/api/tasks/${id}`, {
                id: String(id),
            })
        );
        expect(await responseJson(deleteTask)).toEqual({
            isOk: true,
        });
        expect(taskNotifications.at(-1)).toBe(
            `Task deleted: #${id} Coverage route task updated. This Mira task was deleted; review it in Dashboard when the current work is clear.`
        );
    });
    it("maps job execution validation, missing records, and queue failures", async () => {
        const jobExecutionQueue =
            await import("../../src/services/jobExecutionQueue/repository.ts");
        const { jobExecutionRoutes } =
            await import("../../src/routes/jobExecutionRoutes.ts");
        const missingExecutionId = "018f47a2-9b7c-7cc8-a123-456789abcdef";
        const invalidClaimsPatch = await jobExecutionRoutes[
            "/api/job-executions/claims"
        ].PATCH(
            new Request("https://test.local/api/job-executions/claims", {
                body: JSON.stringify({
                    paused: "yes",
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PATCH",
            })
        );
        expect(invalidClaimsPatch.status).toBe(400);
        try {
            const pausedClaims = await jobExecutionRoutes[
                "/api/job-executions/claims"
            ].PATCH(
                new Request("https://test.local/api/job-executions/claims", {
                    body: JSON.stringify({
                        paused: true,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "PATCH",
                })
            );
            expect(pausedClaims.status).toBe(200);
            expect(await pausedClaims.json()).toMatchObject({
                isOk: true,
                state: {
                    paused: true,
                },
            });
            const pausedQueue = jobExecutionRoutes["/api/job-executions"].GET(
                new Request("https://test.local/api/job-executions?include=claims")
            );
            expect(await pausedQueue.json()).toMatchObject({
                summary: {
                    claimsPaused: true,
                },
            });
        } finally {
            const resumedClaims = await jobExecutionRoutes[
                "/api/job-executions/claims"
            ].PATCH(
                new Request("https://test.local/api/job-executions/claims", {
                    body: JSON.stringify({
                        paused: false,
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "PATCH",
                })
            );
            expect(resumedClaims.status).toBe(200);
            expect(await resumedClaims.json()).toMatchObject({
                state: {
                    paused: false,
                },
            });
        }
        const missingExecution = jobExecutionRoutes["/api/job-executions/:id"].GET(
            requestWithParameters(`/api/job-executions/${missingExecutionId}`, {
                id: missingExecutionId,
            })
        );
        expect(missingExecution.status).toBe(404);
        const invalidCancel = jobExecutionRoutes["/api/job-executions/:id/cancel"].POST(
            requestWithParameters("/api/job-executions/invalid/cancel", {
                id: "invalid",
            })
        );
        expect(invalidCancel.status).toBe(400);
        const missingCancel = jobExecutionRoutes["/api/job-executions/:id/cancel"].POST(
            requestWithParameters(`/api/job-executions/${missingExecutionId}/cancel`, {
                id: missingExecutionId,
            })
        );
        expect(missingCancel.status).toBe(404);
        const listFailure = jest
            .spyOn(jobExecutionQueue, "listJobExecutions")
            .mockImplementationOnce(() => {
                throw new Error("Queue unavailable");
            });
        const failedList = jobExecutionRoutes["/api/job-executions"].GET(
            new Request("https://test.local/api/job-executions")
        );
        expect(failedList.status).toBe(500);
        listFailure.mockRestore();
        const lookupFailure = jest
            .spyOn(jobExecutionQueue, "getJobExecution")
            .mockImplementationOnce(() => {
                throw new Error("Queue unavailable");
            });
        const failedLookup = jobExecutionRoutes["/api/job-executions/:id"].GET(
            requestWithParameters(`/api/job-executions/${missingExecutionId}`, {
                id: missingExecutionId,
            })
        );
        expect(failedLookup.status).toBe(500);
        lookupFailure.mockRestore();
    });
    it("file route listing, hidden path rejection, text writes, binary reads, and directory errors", async () => {
        rememberEnvironment("WORKSPACE_ROOT");
        const workspaceRoot = createTemporaryRoot("mira-file-route-coverage-");
        process.env.WORKSPACE_ROOT = workspaceRoot;
        mkdirSync(path.join(workspaceRoot, "notes"), {
            recursive: true,
        });
        writeFileSync(path.join(workspaceRoot, "notes", "readme.txt"), "hello");
        writeFileSync(path.join(workspaceRoot, "image.png"), "png");
        writeFileSync(path.join(workspaceRoot, "binary.bin"), "a\0b");
        const { fileRoutes } = await import("../../src/routes/fileRoutes.ts");
        const list = fileRoutes["/api/files"].GET(
            new Request("https://test.local/api/files")
        );
        expect(list.json()).resolves.toMatchObject({
            files: expect.arrayContaining([
                expect.objectContaining({
                    name: "notes",
                    type: "directory",
                }),
                expect.objectContaining({
                    name: "image.png",
                    type: "file",
                }),
            ]),
            root: workspaceRoot,
        });
        const hidden = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/.secret")
        );
        expect(hidden.status).toBe(403);
        const hiddenDirectoryList = fileRoutes["/api/files"].GET(
            new Request("https://test.local/api/files?path=notes/.secret")
        );
        expect(hiddenDirectoryList.status).toBe(403);
        expect(hiddenDirectoryList.json()).resolves.toEqual(
            apiErrorExpectation("Access denied: path outside workspace")
        );
        const malformedPath = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/%E0%A4%A")
        );
        expect(malformedPath.status).toBe(400);
        expect(malformedPath.json()).resolves.toEqual(
            apiErrorExpectation("Malformed file path")
        );
        const traversal = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/..%2Foutside.txt")
        );
        expect(traversal.status).toBe(403);
        const missingFile = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/missing.txt")
        );
        expect(missingFile.status).toBe(404);
        const directory = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/notes")
        );
        expect(directory.status).toBe(400);
        const binary = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/binary.bin")
        );
        expect(binary.json()).resolves.toMatchObject({
            content: "[Binary file]",
            isBinary: true,
            path: "binary.bin",
        });
        const image = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/image.png")
        );
        expect(image.json()).resolves.toMatchObject({
            isBinary: true,
            isImage: true,
            mimeType: "image/png",
            path: "image.png",
        });
        const write = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify({
                    content: "updated",
                }),
                method: "PUT",
            })
        );
        expect(await responseJson(write)).toMatchObject({
            isSuccess: true,
            path: "notes/readme.txt",
        });
        expect(
            readFileSync(path.join(workspaceRoot, "notes", "readme.txt"), "utf8")
        ).toBe("updated");
        expect(
            readFileSync(path.join(workspaceRoot, "notes", "readme.txt.bak"), "utf8")
        ).toBe("hello");
        const directoryWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes", {
                body: JSON.stringify({
                    content: "updated",
                }),
                method: "PUT",
            })
        );
        expect(directoryWrite.status).toBe(400);
        const hiddenWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/.secret", {
                body: JSON.stringify({
                    content: "hidden",
                }),
                method: "PUT",
            })
        );
        expect(hiddenWrite.status).toBe(403);
        const invalidWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify({
                    content: 42,
                }),
                method: "PUT",
            })
        );
        expect(invalidWrite.status).toBe(400);
        const arrayWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: JSON.stringify(["not", "an", "object"]),
                method: "PUT",
            })
        );
        expect(arrayWrite.status).toBe(400);
        expect(arrayWrite.json()).resolves.toEqual(
            apiErrorExpectation("body: must be an object", "invalid_request")
        );
        const malformedWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt", {
                body: "{",
                method: "PUT",
            })
        );
        expect(malformedWrite.status).toBe(400);
        const fileParentWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/readme.txt/child.txt", {
                body: JSON.stringify({
                    content: "new",
                }),
                method: "PUT",
            })
        );
        expect(fileParentWrite.status).toBe(403);
        expect(fileParentWrite.json()).resolves.toEqual(
            apiErrorExpectation("Access denied: path outside workspace")
        );
        const tooLargeContent = "x".repeat(1024 * 1024 + 1);
        const largeWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/large.txt", {
                body: JSON.stringify({
                    content: tooLargeContent,
                }),
                method: "PUT",
            })
        );
        expect(largeWrite.status).toBe(413);
        const largeImagePath = path.join(workspaceRoot, "large.png");
        writeFileSync(largeImagePath, Buffer.alloc(1024 * 1024 + 1));
        const largeImage = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/large.png")
        );
        expect(largeImage.status).toBe(413);
        const hardLinkedPath = path.join(workspaceRoot, "notes", "hardlinked.txt");
        writeFileSync(hardLinkedPath, "linked");
        linkSync(
            hardLinkedPath,
            path.join(workspaceRoot, "notes", "hardlinked-copy.txt")
        );
        const hardLinkedRead = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/notes/hardlinked.txt")
        );
        expect(hardLinkedRead.status).toBe(403);
        const hardLinkedWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/hardlinked.txt", {
                body: JSON.stringify({
                    content: "updated",
                }),
                method: "PUT",
            })
        );
        expect(hardLinkedWrite.status).toBe(403);
        const absolutePathRead = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/%2Fetc%2Fpasswd")
        );
        expect(absolutePathRead.status).toBe(403);
        const missingDirectoryList = fileRoutes["/api/files"].GET(
            new Request("https://test.local/api/files?path=missing")
        );
        expect(missingDirectoryList.status).toBe(404);
        const malformedPathWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/%E0%A4%A", {
                body: JSON.stringify({
                    content: "ignored",
                }),
                method: "PUT",
            })
        );
        expect(malformedPathWrite.status).toBe(400);
        const readmePath = path.join(workspaceRoot, "notes", "readme.txt");
        chmodSync(readmePath, 0);
        const unreadableFile = await fileRoutes["/api/files/*"].GET(
            new Request("https://test.local/api/files/notes/readme.txt")
        );
        expect(unreadableFile.status).toBe(403);
        chmodSync(readmePath, 0o600);
        const oversizedExistingPath = path.join(
            workspaceRoot,
            "notes",
            "oversized-existing.txt"
        );
        writeFileSync(oversizedExistingPath, Buffer.alloc(1024 * 1024 + 1));
        const oversizedExistingWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/oversized-existing.txt", {
                body: JSON.stringify({
                    content: "replacement",
                }),
                method: "PUT",
            })
        );
        expect(oversizedExistingWrite.status).toBe(413);
        const fifoPath = path.join(workspaceRoot, "notes", "pipe.txt");
        const fifoResult = Bun.spawnSync({
            cmd: ["/usr/bin/mkfifo", fifoPath],
            stderr: "pipe",
            stdout: "pipe",
        });
        expect(fifoResult.exitCode).toBe(0);
        const fifoWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/notes/pipe.txt", {
                body: JSON.stringify({
                    content: "replacement",
                }),
                method: "PUT",
            })
        );
        expect(fifoWrite.status).toBe(400);
        const missingWorkspaceParent = createTemporaryRoot(
            "mira-file-route-missing-workspace-"
        );
        process.env.WORKSPACE_ROOT = path.join(missingWorkspaceParent, "workspace");
        const createdWorkspaceWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/created.txt", {
                body: JSON.stringify({
                    content: "created",
                }),
                method: "PUT",
            })
        );
        expect(createdWorkspaceWrite.status).toBe(200);
        const fsModule = await import("node:fs");
        const missingParentRace = jest
            .spyOn(fsModule.default, "existsSync")
            .mockReturnValueOnce(false);
        const missingParentWrite = await fileRoutes["/api/files/*"].PUT(
            new Request("https://test.local/api/files/missing/child.txt", {
                body: JSON.stringify({
                    content: "missing parent",
                }),
                method: "PUT",
            })
        );
        missingParentRace.mockRestore();
        expect(missingParentWrite.status).toBe(404);
    });
    it("stores and clears intentional disable metadata for OpenClaw cron jobs", async () => {
        const gatewayModule = await import("../../src/services/gateway/runtime.ts");
        const gateway = gatewayModule.default;
        let shouldFailNextUpdate = false;
        const gatewayRequestSpy = jest
            .spyOn(gateway, "request")
            .mockImplementation((method) => {
                return Promise.try(() => {
                    if (method === "cron.list") {
                        return {
                            jobs: [
                                {
                                    enabled: true,
                                    id: "coverage-linked-cron",
                                    name: "Coverage linked cron",
                                },
                            ],
                        };
                    }
                    if (method === "cron.update") {
                        if (shouldFailNextUpdate) {
                            shouldFailNextUpdate = false;
                            throw Object.assign(new Error("Gateway update failed"), {
                                statusCode: 502,
                            });
                        }
                        return {
                            isOk: true,
                        };
                    }
                    throw new Error(`Unexpected Gateway method: ${method}`);
                });
            });
        cleanupCallbacks.push(() => gatewayRequestSpy.mockRestore());
        const timestamp = "2026-07-20T10:00:00.000Z";
        const result = database
            .prepare(`INSERT INTO tasks (
                    title, body, status, priority, labels_json, automation_json,
                    assignee, created_at, updated_at
                ) VALUES (?, '', 'in-progress', 'medium', ?, ?, 'mira-2026', ?, ?)`)
            .run(
                "Coverage intentional disable task",
                JSON.stringify(["in-progress", "priority-medium"]),
                JSON.stringify({
                    type: "cron",
                    recurring: true,
                    cronJobId: "coverage-linked-cron",
                }),
                timestamp,
                timestamp
            );
        const taskId = Number(result.lastInsertRowid);
        const { cronRoutes } = await import("../../src/routes/cronRoutes.ts");
        const listResponse = await cronRoutes["/api/cron/jobs"].GET();
        expect(listResponse.json()).resolves.toMatchObject({
            jobs: [
                {
                    id: "coverage-linked-cron",
                    taskLinks: [
                        {
                            number: taskId,
                            title: "Coverage intentional disable task",
                        },
                    ],
                },
            ],
        });
        const expiredResponse = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/coverage-linked-cron/toggle",
                {
                    id: "coverage-linked-cron",
                },
                {
                    body: JSON.stringify({
                        enabled: false,
                        disableIntent: {
                            mode: "until",
                            comment: "Already expired",
                            until: "2020-01-01T00:00:00.000Z",
                        },
                    }),
                    method: "POST",
                }
            )
        );
        expect(expiredResponse.status).toBe(400);
        const disableResponse = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/coverage-linked-cron/toggle",
                {
                    id: "coverage-linked-cron",
                },
                {
                    body: JSON.stringify({
                        enabled: false,
                        disableIntent: {
                            mode: "indefinite",
                            comment: "Paused for maintenance",
                        },
                    }),
                    method: "POST",
                }
            )
        );
        expect(disableResponse.status).toBe(200);
        expect(disableResponse.json()).resolves.toEqual({
            isOk: true,
        });
        const disabledMetadata = database
            .prepare(`SELECT disable_intent_json
                 FROM openclaw_cron_job_metadata
                 WHERE job_id = ?`)
            .get("coverage-linked-cron") as {
            disable_intent_json: string;
        };
        expect(JSON.parse(disabledMetadata.disable_intent_json)).toEqual({
            mode: "indefinite",
            comment: "Paused for maintenance",
        });
        const disabledListResponse = await cronRoutes["/api/cron/jobs"].GET();
        expect(disabledListResponse.json()).resolves.toMatchObject({
            jobs: [
                {
                    id: "coverage-linked-cron",
                    disableIntent: {
                        mode: "indefinite",
                        comment: "Paused for maintenance",
                    },
                },
            ],
        });
        const timedDisableResponse = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/coverage-linked-cron/toggle",
                {
                    id: "coverage-linked-cron",
                },
                {
                    body: JSON.stringify({
                        enabled: false,
                        disableIntent: {
                            mode: "until",
                            comment: "Pause until maintenance ends",
                            until: "2999-07-25T12:00:00+02:00",
                        },
                    }),
                    method: "POST",
                }
            )
        );
        expect(timedDisableResponse.status).toBe(200);
        const timedMetadata = database
            .prepare(`SELECT disable_intent_json
                 FROM openclaw_cron_job_metadata
                 WHERE job_id = ?`)
            .get("coverage-linked-cron") as {
            disable_intent_json: string;
        };
        expect(JSON.parse(timedMetadata.disable_intent_json)).toEqual({
            mode: "until",
            comment: "Pause until maintenance ends",
            until: "2999-07-25T10:00:00.000Z",
        });
        const preserveResponse = await cronRoutes["/api/cron/jobs/:id/update"].POST(
            requestWithParameters(
                "/api/cron/jobs/coverage-linked-cron/update",
                {
                    id: "coverage-linked-cron",
                },
                {
                    body: JSON.stringify({
                        patch: {
                            enabled: false,
                        },
                    }),
                    method: "POST",
                }
            )
        );
        expect(preserveResponse.status).toBe(200);
        const preservedMetadata = database
            .prepare(`SELECT disable_intent_json
                 FROM openclaw_cron_job_metadata
                 WHERE job_id = ?`)
            .get("coverage-linked-cron") as {
            disable_intent_json: string;
        };
        expect(JSON.parse(preservedMetadata.disable_intent_json)).toEqual({
            mode: "until",
            comment: "Pause until maintenance ends",
            until: "2999-07-25T10:00:00.000Z",
        });
        shouldFailNextUpdate = true;
        const failedEnableResponse = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/coverage-linked-cron/toggle",
                {
                    id: "coverage-linked-cron",
                },
                {
                    body: JSON.stringify({
                        enabled: true,
                    }),
                    method: "POST",
                }
            )
        );
        expect(failedEnableResponse.status).toBe(502);
        const restoredMetadata = database
            .prepare(`SELECT disable_intent_json
                 FROM openclaw_cron_job_metadata
                 WHERE job_id = ?`)
            .get("coverage-linked-cron") as {
            disable_intent_json: string;
        };
        expect(JSON.parse(restoredMetadata.disable_intent_json)).toEqual({
            mode: "until",
            comment: "Pause until maintenance ends",
            until: "2999-07-25T10:00:00.000Z",
        });
        const enableResponse = await cronRoutes["/api/cron/jobs/:id/toggle"].POST(
            requestWithParameters(
                "/api/cron/jobs/coverage-linked-cron/toggle",
                {
                    id: "coverage-linked-cron",
                },
                {
                    body: JSON.stringify({
                        enabled: true,
                    }),
                    method: "POST",
                }
            )
        );
        expect(enableResponse.status).toBe(200);
        expect(
            database
                .prepare("SELECT job_id FROM openclaw_cron_job_metadata WHERE job_id = ?")
                .get("coverage-linked-cron")
        ).toBeNull();
    });
    it("stores and clears intentional disable metadata for Dashboard jobs", async () => {
        const { jobRoutes } = await import("../../src/routes/jobRoutes.ts");
        const { upsertScheduledJob } =
            await import("../../src/services/scheduledJobs/repository.ts");
        const jobId = `coverage-disable-${Bun.randomUUIDv7()}`;
        cleanupCallbacks.push(() => {
            database.prepare("DELETE FROM scheduled_jobs WHERE id = ?").run(jobId);
        });
        upsertScheduledJob({
            actionKey: "coverage.disable",
            enabled: true,
            id: jobId,
            intervalSeconds: 3600,
            name: "Coverage disable job",
            scheduleType: "interval",
        });
        const expiredResponse = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                `/api/jobs/${jobId}`,
                {
                    id: jobId,
                },
                {
                    body: JSON.stringify({
                        patch: {
                            enabled: false,
                            disableIntent: {
                                mode: "until",
                                comment: "Expired",
                                until: "2020-01-01T00:00:00.000Z",
                            },
                        },
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(expiredResponse.status).toBe(400);
        const disableResponse = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                `/api/jobs/${jobId}`,
                {
                    id: jobId,
                },
                {
                    body: JSON.stringify({
                        patch: {
                            enabled: false,
                            disableIntent: {
                                mode: "indefinite",
                                comment: "  Paused for maintenance  ",
                            },
                        },
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(disableResponse.status).toBe(200);
        expect(disableResponse.json()).resolves.toMatchObject({
            job: {
                disableIntent: {
                    mode: "indefinite",
                    comment: "Paused for maintenance",
                },
                enabled: false,
            },
        });
        const preserveResponse = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                `/api/jobs/${jobId}`,
                {
                    id: jobId,
                },
                {
                    body: JSON.stringify({
                        patch: {
                            intervalSeconds: 7200,
                        },
                    }),
                    method: "PATCH",
                }
            )
        );
        expect(preserveResponse.json()).resolves.toMatchObject({
            job: {
                disableIntent: {
                    mode: "indefinite",
                    comment: "Paused for maintenance",
                },
            },
        });
        const clearIntentResponse = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                `/api/jobs/${jobId}`,
                {
                    id: jobId,
                },
                {
                    body: JSON.stringify({
                        patch: {
                            disableIntent: null,
                            enabled: false,
                        },
                    }),
                    method: "PATCH",
                }
            )
        );
        const clearedIntentJobResponse = await responseJson(clearIntentResponse);
        expect(clearedIntentJobResponse).toMatchObject({
            job: {
                enabled: false,
            },
        });
        expect(clearedIntentJobResponse.job).not.toHaveProperty("disableIntent");
        const clearedStoredIntent = database
            .prepare("SELECT disable_intent_json FROM scheduled_jobs WHERE id = ?")
            .get(jobId) as {
            disable_intent_json: string | null;
        };
        expect(clearedStoredIntent.disable_intent_json).toBeNull();
        const enableResponse = await jobRoutes["/api/jobs/:id"].PATCH(
            requestWithParameters(
                `/api/jobs/${jobId}`,
                {
                    id: jobId,
                },
                {
                    body: JSON.stringify({
                        patch: {
                            enabled: true,
                        },
                    }),
                    method: "PATCH",
                }
            )
        );
        const enabledJobResponse = await responseJson(enableResponse);
        expect(enabledJobResponse).toMatchObject({
            job: {
                enabled: true,
            },
        });
        expect(enabledJobResponse.job).not.toHaveProperty("disableIntent");
        const stored = database
            .prepare("SELECT disable_intent_json FROM scheduled_jobs WHERE id = ?")
            .get(jobId) as {
            disable_intent_json: string | null;
        };
        expect(stored.disable_intent_json).toBeNull();
    });
    it("keeps primary OpenClaw data separate from the Dashboard client identity", async () => {
        rememberEnvironment("HOME");
        rememberEnvironment("OPENCLAW_HOME");
        rememberEnvironment("MIRA_DASHBOARD_OPENCLAW_HOME");
        rememberEnvironment("WORKSPACE_ROOT");
        const homeRoot = createTemporaryRoot("mira-primary-openclaw-home-");
        const primaryRoot = path.join(homeRoot, ".openclaw");
        const dashboardClientRoot = createTemporaryRoot("mira-dashboard-client-home-");
        mkdirSync(path.join(primaryRoot, "media", "images"), {
            recursive: true,
        });
        mkdirSync(path.join(primaryRoot, "workspace"), {
            recursive: true,
        });
        mkdirSync(path.join(dashboardClientRoot, "media", "images"), {
            recursive: true,
        });
        mkdirSync(path.join(dashboardClientRoot, "workspace"), {
            recursive: true,
        });
        writeFileSync(path.join(primaryRoot, "openclaw.json"), '{"primary":true}\n');
        writeFileSync(
            path.join(dashboardClientRoot, "openclaw.json"),
            '{"clientIdentity":true}\n'
        );
        writeFileSync(path.join(primaryRoot, "workspace", "primary.txt"), "primary");
        writeFileSync(
            path.join(dashboardClientRoot, "workspace", "client.txt"),
            "client"
        );
        writeFileSync(
            path.join(primaryRoot, "media", "images", "primary.txt"),
            "primary media"
        );
        writeFileSync(
            path.join(dashboardClientRoot, "media", "images", "client.txt"),
            "client media"
        );
        process.env.HOME = homeRoot;
        delete process.env.OPENCLAW_HOME;
        process.env.MIRA_DASHBOARD_OPENCLAW_HOME = dashboardClientRoot;
        delete process.env.WORKSPACE_ROOT;
        const { configFileRoutes } = await import("../../src/routes/configFileRoutes.ts");
        const configList = await responseJson(
            configFileRoutes["/api/config-files"].GET()
        );
        expect(configList.root).toBe(primaryRoot);
        const { fileRoutes } = await import("../../src/routes/fileRoutes.ts");
        const workspaceList = await responseJson(
            fileRoutes["/api/files"].GET(new Request("https://test.local/api/files"))
        );
        expect(workspaceList).toMatchObject({
            files: [
                expect.objectContaining({
                    name: "primary.txt",
                }),
            ],
            root: path.join(primaryRoot, "workspace"),
        });
        const { mediaRoutes } = await import("../../src/routes/mediaRoutes.ts");
        const media = await mediaRoutes["/api/media"].GET(
            new Request(
                "https://test.local/api/media?path=images/primary.txt&preview=text"
            )
        );
        expect(media.status).toBe(200);
        expect(media.text()).resolves.toBe("primary media");
        const agentId = `separation-${Bun.randomUUIDv7()}`;
        try {
            const { updateAgentCurrentTask } =
                await import("../../src/services/agents/statusService.ts");
            await updateAgentCurrentTask(agentId, "Primary OpenClaw root");
            expect(
                existsSync(
                    path.join(primaryRoot, "agents", agentId, "sessions", "metadata.json")
                )
            ).toBe(true);
            expect(existsSync(path.join(dashboardClientRoot, "agents", agentId))).toBe(
                false
            );
        } finally {
            database
                .prepare("DELETE FROM agent_task_history WHERE agent_id = ?")
                .run(agentId);
        }
    });
    it("config file route allowlist, reads, writes, and backups", async () => {
        isolateOpenClawEnvironment("mira-config-file-route-");
        const root = process.env.OPENCLAW_HOME!;
        mkdirSync(path.join(root, "hooks", "transforms"), {
            recursive: true,
        });
        writeFileSync(path.join(root, "openclaw.json"), '{"model":"codex"}\n');
        writeFileSync(
            path.join(root, "hooks", "transforms", "agentmail.ts"),
            "export default {}\n"
        );
        const { configFileRoutes } = await import("../../src/routes/configFileRoutes.ts");
        const listed = configFileRoutes["/api/config-files"].GET();
        const listedJson = await responseJson(listed);
        expect((listedJson.files as unknown[]).length).toBe(2);
        expect(listedJson.root).toBe(root);
        const deniedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/secrets.env")
        );
        expect(deniedRead.status).toBe(403);
        const missingAllowedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/hooks/transforms/missing.ts")
        );
        expect(missingAllowedRead.status).toBe(403);
        const malformedConfigPath = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/%E0%A4%A")
        );
        expect(malformedConfigPath.status).toBe(400);
        const read = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(read.json()).resolves.toMatchObject({
            content: '{\n  "model": "codex"\n}\n',
            isBinary: false,
            masked: true,
            path: "config:openclaw.json",
            relativePath: "openclaw.json",
            size: 18,
        });
        writeFileSync(path.join(root, "openclaw.json"), "{");
        const invalidMaskedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(invalidMaskedRead.json()).resolves.toMatchObject({
            content: "",
            masked: true,
            maskingError: "invalid_json",
        });
        const invalidRevealedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json?reveal=1")
        );
        expect(invalidRevealedRead.headers.get("Cache-Control")).toBe("no-store");
        expect(invalidRevealedRead.json()).resolves.toMatchObject({
            content: "{",
            masked: false,
        });
        writeFileSync(path.join(root, "openclaw.json"), '{"model":"codex"}\n');
        const invalidWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: 42,
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(invalidWrite.status).toBe(400);
        const malformedWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: "{",
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(malformedWrite.status).toBe(400);
        const arrayWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify([]),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(arrayWrite.status).toBe(400);
        const missingContentWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({}),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(missingContentWrite.status).toBe(400);
        const oversizedConfigContent = "x".repeat(2 * 1024 * 1024 + 1);
        const tooLargeConfigWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: oversizedConfigContent,
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(tooLargeConfigWrite.status).toBe(400);
        const maskedPlaceholderWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: `{"token":"${CONFIG_REDACTION_SENTINEL}"}`,
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(maskedPlaceholderWrite.status).toBe(400);
        expect(maskedPlaceholderWrite.json()).resolves.toEqual(
            apiErrorExpectation(
                "Masked config cannot be saved; reveal and verify the file first"
            )
        );
        const written = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: '{"model":"glm51"}\n',
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(written.json()).resolves.toMatchObject({
            isSuccess: true,
            path: "config:openclaw.json",
            relativePath: "openclaw.json",
            size: 18,
        });
        expect(Bun.file(path.join(root, "openclaw.json")).text()).resolves.toBe(
            '{"model":"glm51"}\n'
        );
        expect(Bun.file(path.join(root, "openclaw.json.bak")).text()).resolves.toBe(
            '{"model":"codex"}\n'
        );
        writeFileSync(path.join(root, "openclaw.json"), "a\0b");
        const binaryRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(binaryRead.json()).resolves.toMatchObject({
            content: "[Binary file]",
            isBinary: true,
            path: "config:openclaw.json",
        });
        const symlinkedConfig = path.join(root, "hooks", "transforms", "agentmail.ts");
        unlinkSync(symlinkedConfig);
        symlinkSync(path.join(root, "openclaw.json"), symlinkedConfig);
        const symlinkedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts"
            )
        );
        expect(symlinkedRead.status).toBe(404);
        const symlinkedWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts",
                {
                    body: JSON.stringify({
                        content: "export default {}\n",
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "PUT",
                }
            )
        );
        expect(symlinkedWrite.status).toBe(403);
        unlinkSync(symlinkedConfig);
        writeFileSync(symlinkedConfig, "export default {}\n");
        const linkedConfig = path.join(root, "hooks", "transforms", "agentmail.ts");
        linkSync(linkedConfig, `${linkedConfig}.hardlink`);
        const hardLinkedConfigWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts",
                {
                    body: JSON.stringify({
                        content: "export default {}\n",
                    }),
                    headers: {
                        "Content-Type": "application/json",
                    },
                    method: "PUT",
                }
            )
        );
        expect(hardLinkedConfigWrite.status).toBe(403);
        writeFileSync(path.join(root, "openclaw.json"), "x".repeat(2 * 1024 * 1024 + 1));
        const oversizedMaskedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(oversizedMaskedRead.json()).resolves.toMatchObject({
            content: "",
            masked: true,
            maskingError: "truncated_json",
            truncated: true,
        });
        const oversizedRevealedRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json?reveal=1")
        );
        expect(oversizedRevealedRead.headers.get("Cache-Control")).toBe("no-store");
        const oversizedExistingWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: "{}\n",
                }),
                headers: {
                    "Content-Type": "application/json",
                },
                method: "PUT",
            })
        );
        expect(oversizedExistingWrite.status).toBe(413);
        const hardLinkedConfigRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts"
            )
        );
        expect(hardLinkedConfigRead.status).toBe(403);
        const malformedPathWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/%E0%A4%A", {
                body: JSON.stringify({
                    content: "{}\n",
                }),
                method: "PUT",
            })
        );
        expect(malformedPathWrite.status).toBe(400);
        const openclawConfig = path.join(root, "openclaw.json");
        chmodSync(openclawConfig, 0);
        const unreadableConfig = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(unreadableConfig.status).toBe(403);
        chmodSync(openclawConfig, 0o600);
        rmSync(openclawConfig);
        mkdirSync(openclawConfig);
        const directoryRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(directoryRead.status).toBe(403);
        const directoryConfigWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: "{}\n",
                }),
                method: "PUT",
            })
        );
        expect(directoryConfigWrite.status).toBe(400);
        unlinkSync(linkedConfig);
        const missingConfiguredRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request(
                "https://test.local/api/config-files/hooks/transforms/agentmail.ts"
            )
        );
        expect(missingConfiguredRead.status).toBe(404);
        process.env.OPENCLAW_HOME = "relative-openclaw-home";
        const unconfiguredList = configFileRoutes["/api/config-files"].GET();
        expect(unconfiguredList.status).toBe(500);
        const unconfiguredRead = await configFileRoutes["/api/config-files/*"].GET(
            new Request("https://test.local/api/config-files/openclaw.json")
        );
        expect(unconfiguredRead.status).toBe(500);
        const unconfiguredWrite = await configFileRoutes["/api/config-files/*"].PUT(
            new Request("https://test.local/api/config-files/openclaw.json", {
                body: JSON.stringify({
                    content: "{}\n",
                }),
                method: "PUT",
            })
        );
        expect(unconfiguredWrite.status).toBe(500);
    });
});
