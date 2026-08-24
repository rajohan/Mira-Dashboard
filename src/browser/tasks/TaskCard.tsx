import { useDraggable } from "@dnd-kit/react";
import { GripVertical, UserRound } from "lucide-react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import type { TaskSummary } from "../../contracts/taskModel.ts";
import { cn } from "../lib/classNames.ts";
import { openClawCronOperationalStatus } from "../openClawCron/presentation.ts";
import { Badge } from "../ui/Badge.tsx";
import { Icon } from "../ui/Icon.tsx";
import { StretchedAction } from "../ui/StretchedAction.tsx";
import { TaskLabelBadge } from "./TaskLabelBadge.tsx";
import {
    taskAssigneeLabel,
    taskPriorityBadgeVariant,
    taskRelativeTime,
} from "./taskPresentation.ts";

interface TaskCardContentProps {
    readonly automationJob?: OpenClawCronJob;
    readonly overlay?: boolean;
    readonly task: TaskSummary;
}

/** @returns Presentational task-card content shared by the board and drag overlay. */
export function TaskCardContent({
    automationJob,
    overlay = false,
    task,
}: TaskCardContentProps) {
    const automationStatus =
        automationJob === undefined
            ? undefined
            : openClawCronOperationalStatus(automationJob);
    return (
        <div
            className={cn(
                "border-primary-700 bg-primary-800 rounded-lg border p-3 shadow-sm transition-colors",
                overlay
                    ? "border-accent-400 w-72 shadow-xl shadow-black/40"
                    : "group-hover:border-primary-500 group-focus-within:border-accent-400"
            )}
        >
            <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-primary-400 mr-0.5 text-xs font-medium tabular-nums">
                    #{task.number}
                </span>
                <Badge
                    className="capitalize"
                    variant={taskPriorityBadgeVariant(task.priority)}
                >
                    {task.priority}
                </Badge>
                {task.automation !== undefined && (
                    <>
                        <Badge variant="info">
                            {task.automation.recurring ? "Recurring" : "Automated"}
                        </Badge>
                        {automationStatus !== undefined && (
                            <Badge variant={automationStatus.variant}>
                                {automationStatus.label}
                            </Badge>
                        )}
                    </>
                )}
            </div>
            <p className="text-primary-100 mt-2 line-clamp-3 text-sm font-medium wrap-break-word">
                {task.title}
            </p>
            {task.labels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {task.labels.slice(0, 3).map((label) => (
                        <TaskLabelBadge key={label} label={label} />
                    ))}
                    {task.labels.length > 3 && (
                        <span className="text-primary-400 px-1 text-xs">
                            +{task.labels.length - 3}
                        </span>
                    )}
                </div>
            )}
            <div className="text-primary-400 mt-3 flex items-center justify-between gap-2 text-xs">
                <span className="flex min-w-0 items-center gap-1.5 truncate">
                    <Icon icon={UserRound} size="sm" />
                    <span className="truncate">{taskAssigneeLabel(task.assignee)}</span>
                </span>
                <time
                    className="shrink-0"
                    dateTime={new Date(task.updatedAtMs).toISOString()}
                >
                    {taskRelativeTime(task.updatedAtMs)}
                </time>
            </div>
        </div>
    );
}

interface TaskCardProps {
    readonly automationJob?: OpenClawCronJob;
    readonly disabled: boolean;
    readonly onSelect: (taskId: string) => void;
    readonly task: TaskSummary;
}

/** @returns One draggable, keyboard-selectable task card. */
export function TaskCard({ automationJob, disabled, onSelect, task }: TaskCardProps) {
    const { isDragging, ref } = useDraggable({
        disabled,
        id: `task:${task.id}`,
        type: "task-card",
    });

    return (
        <article
            className={cn(
                "group relative",
                isDragging && "opacity-35",
                disabled && "opacity-70"
            )}
        >
            <TaskCardContent automationJob={automationJob} task={task} />
            <StretchedAction
                className="cursor-grab active:cursor-grabbing"
                disabled={disabled}
                label={`Open task #${task.number}: ${task.title}`}
                onClick={() => onSelect(task.id)}
                ref={ref}
            />
            <span
                aria-hidden="true"
                className="text-primary-500 group-hover:text-primary-300 pointer-events-none absolute top-3 right-3 opacity-100 transition-colors md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
            >
                <Icon icon={GripVertical} size="sm" />
            </span>
        </article>
    );
}
