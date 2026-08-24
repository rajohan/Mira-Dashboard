import { formatDistanceToNowStrict } from "date-fns";

import {
    taskAssignees,
    type TaskAssigneeId,
    type TaskPriority,
    type TaskStatus,
} from "../../contracts/taskModel.ts";

interface TaskStatusDefinition {
    readonly dotClassName: string;
    readonly emptyLabel: string;
    readonly status: TaskStatus;
    readonly title: string;
}

export const taskStatusDefinitions: readonly TaskStatusDefinition[] = Object.freeze([
    {
        dotClassName: "bg-primary-400",
        emptyLabel: "No queued tasks",
        status: "todo",
        title: "To do",
    },
    {
        dotClassName: "bg-accent-400",
        emptyLabel: "No active tasks",
        status: "in-progress",
        title: "In progress",
    },
    {
        dotClassName: "bg-amber-400",
        emptyLabel: "No blocked tasks",
        status: "blocked",
        title: "Blocked",
    },
    {
        dotClassName: "bg-emerald-400",
        emptyLabel: "No completed tasks",
        status: "done",
        title: "Done",
    },
]);

/**
 * @param assignee Optional task owner.
 * @returns Human-readable label for one task owner.
 */
export function taskAssigneeLabel(assignee: TaskAssigneeId | undefined): string {
    if (assignee === undefined) return "Unassigned";
    return taskAssignees.find(({ id }) => id === assignee)?.label ?? assignee;
}

/** @returns Shared task-priority badge treatment. */
export function taskPriorityBadgeVariant(
    priority: TaskPriority
): "danger" | "default" | "warning" {
    switch (priority) {
        case "high": {
            return "danger";
        }
        case "medium": {
            return "warning";
        }
        case "low": {
            return "default";
        }
    }
}

/**
 * @param timestampMs Valid task timestamp.
 * @returns Compact relative age for one task timestamp.
 */
export function taskRelativeTime(timestampMs: number): string {
    return formatDistanceToNowStrict(new Date(timestampMs), { addSuffix: true });
}
