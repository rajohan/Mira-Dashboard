import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import type { Task } from "../../../types/task";
import { formatDuration } from "../../../utils/format";
import { getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";
import { Badge } from "../../ui/Badge";

/** Provides props for task card. */
interface TaskCardProps {
    task: Task;
    isDragging?: boolean;
    onClick: () => void;
}

/** Renders the task card UI. */
export function TaskCard({ task, isDragging, onClick }: TaskCardProps) {
    const { attributes, listeners, setNodeRef, transform } = useSortable({
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

    return (
        <div
            ref={setNodeRef}
            style={style}
            {...attributes}
            className={
                "group border-primary-700 bg-primary-800 relative cursor-pointer rounded-lg border p-3 transition-all " +
                "hover:border-primary-600 " +
                (isDragging ? "border-accent-500 cursor-grabbing opacity-90" : "")
            }
            onClick={onClick}
        >
            <button
                {...listeners}
                aria-label={`Drag task #${task.number}`}
                className="text-primary-500 hover:text-primary-300 md:text-primary-600 absolute top-1/2 left-1.5 -translate-y-1/2 cursor-grab transition-opacity md:opacity-0 md:group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <GripVertical className="h-4 w-4" />
            </button>

            <div className="ml-3 min-w-0">
                <div className="mb-1.5 flex min-w-0 flex-wrap items-center gap-2">
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
                    {task.automation?.recurring && (
                        <Badge variant="cron" className="px-1.5 text-[10px]">
                            Recurring
                        </Badge>
                    )}
                </div>

                <h3 className="text-primary-200 mb-1.5 line-clamp-2 text-sm font-medium break-words">
                    {task.title}
                </h3>

                <div className="flex items-center justify-between gap-2">
                    <span className="text-primary-500 truncate text-xs">
                        {formatDuration(new Date(task.updatedAt).getTime())}
                    </span>
                    {assignee && (
                        <div className="flex items-center gap-1">
                            {assignee.avatar_url ? (
                                <img
                                    src={assignee.avatar_url}
                                    alt={assignee.login || "Avatar"}
                                    className="h-5 w-5 rounded-full"
                                />
                            ) : (
                                <div className="bg-primary-700 text-primary-300 flex h-5 w-5 items-center justify-center rounded-full text-[10px]">
                                    {(assignee.login ||
                                        assignee.name ||
                                        "?")[0].toUpperCase()}
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
