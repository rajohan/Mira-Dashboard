import { useDraggable } from "@dnd-kit/react";
import { Bot, GripVertical, UserRound } from "lucide-react";

import type { TaskSummary } from "../../contracts/taskModel.ts";
import { cn } from "../lib/classNames.ts";
import { Badge } from "../ui/Badge.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import {
    taskAssigneeLabel,
    taskPriorityBadgeVariant,
    taskRelativeTime,
} from "./taskPresentation.ts";

interface TaskCardContentProps {
    readonly overlay?: boolean;
    readonly task: TaskSummary;
}

/** @returns Presentational task-card content shared by the board and drag overlay. */
export function TaskCardContent({ overlay = false, task }: TaskCardContentProps) {
    return (
        <div
            className={cn(
                "border-primary-700 bg-primary-800 rounded-lg border p-3 shadow-sm transition-colors",
                overlay && "border-accent-400 w-72 shadow-xl shadow-black/40"
            )}
        >
            <div className="flex flex-wrap items-center gap-1.5">
                <Badge variant={taskPriorityBadgeVariant(task.priority)}>
                    {task.priority}
                </Badge>
                {task.automation !== undefined && (
                    <Badge variant="info">
                        <Icon icon={Bot} size="sm" tone="inherit" />
                        {task.automation.recurring ? "Recurring" : "Automated"}
                    </Badge>
                )}
            </div>
            <p className="text-primary-100 mt-2 line-clamp-3 text-sm font-medium wrap-break-word">
                {task.title}
            </p>
            {task.labels.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1">
                    {task.labels.slice(0, 3).map((label) => (
                        <span
                            className="bg-primary-700/70 text-primary-300 rounded px-1.5 py-0.5 text-xs"
                            key={label}
                        >
                            {label}
                        </span>
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
    readonly disabled: boolean;
    readonly onSelect: (taskId: string) => void;
    readonly task: TaskSummary;
}

/** @returns One draggable, keyboard-selectable task card. */
export function TaskCard({ disabled, onSelect, task }: TaskCardProps) {
    const { handleRef, isDragging, ref } = useDraggable({
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
            ref={ref}
        >
            <TaskCardContent task={task} />
            <button
                aria-label={`Open task: ${task.title}`}
                className="focus-visible:ring-accent-400 absolute inset-0 rounded-lg outline-none focus-visible:ring-2"
                onClick={() => onSelect(task.id)}
                type="button"
            />
            <IconOnlyButton
                className="absolute top-2 right-2 z-10 cursor-grab opacity-100 active:cursor-grabbing md:opacity-0 md:group-focus-within:opacity-100 md:group-hover:opacity-100"
                disabled={disabled}
                icon={GripVertical}
                label={`Move task: ${task.title}`}
                ref={handleRef}
                size="sm"
                variant="ghost"
            />
        </article>
    );
}
