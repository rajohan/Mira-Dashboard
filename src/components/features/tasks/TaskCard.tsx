import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import type { Task } from "../../../types/task";
import { formatCronLastStatus, getCronStatusVariant } from "../../../utils/cronUtils";
import { formatDuration } from "../../../utils/format";
import { getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";
import { Badge } from "../../ui/Badge";

/** Provides props for task card. */
interface TaskCardProps {
    task: Task;
    isDragging?: boolean;
    onClick: () => void;
}

/** Returns compact automation status for task cards. */
function getTaskAutomationBadge(automation: Task["automation"]) {
    if (!automation?.recurring) {
        return null;
    }

    if (automation.runningAtMs) {
        return { label: "Running", variant: "warning" as const };
    }

    if (automation.enabled === false) {
        return { label: "Disabled", variant: "default" as const };
    }

    if (automation.lastRunStatus) {
        return {
            label: formatCronLastStatus(automation.lastRunStatus),
            variant: getCronStatusVariant(automation.lastRunStatus),
        };
    }

    return { label: "Recurring", variant: "cron" as const };
}

/** Renders the task card UI. */
export function TaskCard({ task, isDragging, onClick }: TaskCardProps) {
    const { attributes, listeners, setActivatorNodeRef, setNodeRef, transform } =
        useSortable({
            id: String(task.number),
        });

    const style = transform
        ? {
              transform: CSS.Translate.toString(transform),
              zIndex: isDragging ? 50 : undefined,
          }
        : undefined;

    const priority = getPriority(task.labels);
    const assignee = task.assignees[0];
    const automationBadge = getTaskAutomationBadge(task.automation);

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={
                "group border-primary-700 bg-primary-800 relative rounded-lg border p-3 transition-all " +
                "hover:border-primary-600 " +
                (isDragging ? "border-accent-500 cursor-grabbing opacity-90" : "")
            }
        >
            <button
                ref={setActivatorNodeRef}
                type="button"
                {...attributes}
                {...listeners}
                aria-label={`Drag task #${task.number}`}
                className="text-primary-500 hover:text-primary-300 focus:ring-accent-400 md:text-primary-600 absolute top-1/2 left-1.5 -translate-y-1/2 cursor-grab rounded transition-opacity focus:opacity-100 focus:ring-2 focus:outline-none md:opacity-0 md:group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <GripVertical className="h-4 w-4" />
            </button>

            <button
                type="button"
                aria-label={`Open task #${task.number}: ${task.title}`}
                className="focus:ring-accent-400 ml-3 block min-w-0 cursor-pointer rounded text-left focus:ring-2 focus:outline-none"
                onClick={onClick}
            >
                <span className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
                    <span className="text-primary-500 shrink-0 text-xs">
                        #{task.number}
                    </span>
                    <span
                        className={
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                            PRIORITY_COLORS[priority]
                        }
                    >
                        {priority.toUpperCase()}
                    </span>
                    {automationBadge && (
                        <Badge
                            variant={automationBadge.variant}
                            className="px-1.5 text-[10px]"
                        >
                            {automationBadge.label}
                        </Badge>
                    )}
                </span>

                <span
                    role="heading"
                    aria-level={3}
                    className="text-primary-200 mb-1.5 line-clamp-2 text-sm font-medium break-words"
                >
                    {task.title}
                </span>

                <span className="flex items-center justify-between gap-2">
                    <span className="text-primary-500 truncate text-xs">
                        {formatDuration(new Date(task.updatedAt).getTime())}
                    </span>
                    {assignee && (
                        <span className="flex items-center gap-1">
                            {assignee.avatar_url ? (
                                <img
                                    src={assignee.avatar_url}
                                    alt={assignee.login || "Avatar"}
                                    className="h-5 w-5 rounded-full"
                                />
                            ) : (
                                <span className="bg-primary-700 text-primary-300 flex h-5 w-5 items-center justify-center rounded-full text-[10px]">
                                    {(assignee.login ||
                                        assignee.name ||
                                        "?")[0].toUpperCase()}
                                </span>
                            )}
                        </span>
                    )}
                </span>
            </button>
        </div>
    );
}
