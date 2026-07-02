import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import type { Task } from "../../../types/task";
import { formatCronLastStatus, getCronStatusVariant } from "../../../utils/cronUtilities";
import { timestampFromDateString } from "../../../utils/date";
import { formatDuration } from "../../../utils/format";
import { getPriority, PRIORITY_COLORS } from "../../../utils/taskUtilities";
import { Badge } from "../../ui/Badge";

/** Provides props for task card. */
interface TaskCardProperties {
    task: Task;
    isDragging?: boolean;
    onClick: () => void;
}

/** Returns compact live automation status for task cards. */
function getTaskAutomationStatusBadge(automation: Task["automation"]) {
    if (!automation?.recurring) {
        return;
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

    return;
}

/** Renders the task card UI. */
export function TaskCard({ task, isDragging, onClick }: TaskCardProperties) {
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
    const automationStatusBadge = getTaskAutomationStatusBadge(task.automation);

    return (
        <div
            ref={setNodeRef}
            style={style}
            className={
                "group relative rounded-lg border border-primary-700 bg-primary-800 p-3 transition-all " +
                "hover:border-primary-600 " +
                (isDragging ? "cursor-grabbing border-accent-500 opacity-90" : "")
            }
        >
            <button
                ref={setActivatorNodeRef}
                type="button"
                {...attributes}
                {...listeners}
                aria-label={`Drag task #${task.number}`}
                className="absolute top-1/2 left-1.5 -translate-y-1/2 cursor-grab rounded text-primary-500 transition-opacity hover:text-primary-300 focus:opacity-100 focus:ring-2 focus:ring-accent-400 focus:outline-none md:text-primary-600 md:opacity-0 md:group-hover:opacity-100"
                onClick={(event_) => event_.stopPropagation()}
            >
                <GripVertical className="size-4" />
            </button>

            <button
                type="button"
                aria-label={`Open task #${task.number}: ${task.title}`}
                className="ml-3 block min-w-0 cursor-pointer rounded text-left focus:ring-2 focus:ring-accent-400 focus:outline-none"
                onClick={onClick}
            >
                <span className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
                    <span className="shrink-0 text-xs text-primary-500">
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
                    {task.automation?.recurring && (
                        <Badge variant="cron" className="px-1.5 text-[10px]">
                            Recurring
                        </Badge>
                    )}
                    {automationStatusBadge && (
                        <Badge
                            variant={automationStatusBadge.variant}
                            className="px-1.5 text-[10px]"
                        >
                            {automationStatusBadge.label}
                        </Badge>
                    )}
                </span>

                <span
                    role="heading"
                    aria-level={3}
                    className="mb-1.5 line-clamp-2 text-sm font-medium wrap-break-word text-primary-200"
                >
                    {task.title}
                </span>

                <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs text-primary-500">
                        {formatDuration(timestampFromDateString(task.updatedAt))}
                    </span>
                    {assignee && (
                        <span className="flex items-center gap-1">
                            {assignee.avatar_url ? (
                                <img
                                    src={assignee.avatar_url}
                                    alt={assignee.login || "Avatar"}
                                    className="size-5 rounded-full"
                                />
                            ) : (
                                <span className="flex size-5 items-center justify-center rounded-full bg-primary-700 text-[10px] text-primary-300">
                                    {(assignee.login || assignee.name || "?")
                                        .charAt(0)
                                        .toUpperCase()}
                                </span>
                            )}
                        </span>
                    )}
                </span>
            </button>
        </div>
    );
}
