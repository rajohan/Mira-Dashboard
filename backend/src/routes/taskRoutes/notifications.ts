import { currentRequestAuditContext } from "../../http/requestAuditContext.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import { isDevelopmentExternalNotificationSuppressed } from "../../requestPolicy/evaluator.ts";
import gateway from "../../services/gateway/runtime.ts";

const logger = createStructuredLogger("tasks");
const MIRA_TASK_TRACKING_AUTOMATION_ID = "openclaw-task-tracking";

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

function miraAutomationTaskNotificationMessage(
    eventType: MiraTaskNotificationEvent,
    taskId: number
): string {
    if (eventType === "progress") {
        return `Task ${eventType}: #${taskId}. A scoped automation added progress to this Mira task; review it in Dashboard when the current work is clear.`;
    }
    return `Task ${eventType}: #${taskId}. A scoped automation changed this Mira task; review it in Dashboard when the current work is clear.`;
}

export async function notifyMira(
    eventType: MiraTaskNotificationEvent,
    task: { id: number; title: string }
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
                ? miraAutomationTaskNotificationMessage(eventType, task.id)
                : miraTaskNotificationMessage(eventType, task)
        );
    } catch (error) {
        logger.error("tasks.mira_notification_failed", { error });
    }
}
