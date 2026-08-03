import { currentRequestAuditContext } from "../../http/requestAuditContext.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { isDevelopmentExternalNotificationSuppressed } from "../../requestPolicy/evaluator.ts";
import gateway from "../../services/gateway/runtime.ts";

const logger = createStructuredLogger("tasks");
const MIRA_TASK_TRACKING_AUTOMATION_ID = "openclaw-task-tracking";

type MiraTaskNotificationEvent =
    | "assigned"
    | "comment-added"
    | "comment-deleted"
    | "comment-edited"
    | "created"
    | "deleted"
    | "moved"
    | "updated";

interface MiraTaskNotificationTarget {
    detail?: string;
    id: number;
    title: string;
}

const notificationEventLabel: Record<MiraTaskNotificationEvent, string> = {
    assigned: "assigned",
    "comment-added": "comment added",
    "comment-deleted": "comment deleted",
    "comment-edited": "comment edited",
    created: "created",
    deleted: "deleted",
    moved: "moved",
    updated: "updated",
};

const notificationEventDescription: Record<MiraTaskNotificationEvent, string> = {
    assigned: "This Mira task's assignment changed",
    "comment-added": "A comment was added to this Mira task",
    "comment-deleted": "A comment on this Mira task was deleted",
    "comment-edited": "A comment on this Mira task was edited",
    created: "This task was assigned to Mira",
    deleted: "This Mira task was deleted",
    moved: "This Mira task moved columns",
    updated: "This Mira task was updated",
};

const automationEventDescription: Record<MiraTaskNotificationEvent, string> = {
    assigned: "A scoped automation changed this Mira task's assignment",
    "comment-added": "A scoped automation added a comment to this Mira task",
    "comment-deleted": "A scoped automation deleted a comment from this Mira task",
    "comment-edited": "A scoped automation edited a comment on this Mira task",
    created: "A scoped automation created this Mira task",
    deleted: "A scoped automation deleted this Mira task",
    moved: "A scoped automation moved this Mira task",
    updated: "A scoped automation updated this Mira task",
};

function notificationDetail(task: MiraTaskNotificationTarget): string {
    return task.detail ? ` → ${task.detail}` : "";
}

function miraTaskNotificationMessage(
    eventType: MiraTaskNotificationEvent,
    task: MiraTaskNotificationTarget
): string {
    const taskLabel = `#${task.id} ${task.title}${notificationDetail(task)}`;
    return `Task ${notificationEventLabel[eventType]}: ${taskLabel}. ${notificationEventDescription[eventType]}; review it in Dashboard when the current work is clear.`;
}

function miraAutomationTaskNotificationMessage(
    eventType: MiraTaskNotificationEvent,
    task: MiraTaskNotificationTarget
): string {
    const taskLabel = `#${task.id}${notificationDetail(task)}`;
    return `Task ${notificationEventLabel[eventType]}: ${taskLabel}. ${automationEventDescription[eventType]}; review it in Dashboard when the current work is clear.`;
}

export async function notifyMira(
    eventType: MiraTaskNotificationEvent,
    task: MiraTaskNotificationTarget
) {
    if (isDevelopmentExternalNotificationSuppressed()) return;
    const actor = currentRequestAuditContext()?.actor;
    if (actor?.type === "automation" && actor.id === MIRA_TASK_TRACKING_AUTOMATION_ID) {
        return;
    }
    const isAutomation = actor?.type === "automation";
    try {
        await gateway.sendSessionMessage(
            "main",
            isAutomation
                ? miraAutomationTaskNotificationMessage(eventType, task)
                : miraTaskNotificationMessage(eventType, task)
        );
    } catch (error) {
        logger.error("tasks.mira_notification_failed", { error });
    }
}
