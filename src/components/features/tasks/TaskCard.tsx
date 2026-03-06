import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVertical } from "lucide-react";

import type { Task } from "../../../types/task";
import { formatDuration } from "../../../utils/format";
import { getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";

interface TaskCardProps {
    task: Task;
    isDragging?: boolean;
    onClick: () => void;
}

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
                "group relative cursor-pointer rounded-lg border border-primary-700 bg-primary-800 p-3 transition-all " +
                "hover:border-primary-600 " +
                (isDragging ? "cursor-grabbing border-accent-500 opacity-90" : "")
            }
            onClick={onClick}
        >
            <button
                {...listeners}
                className="-tranprimary-y-1/2 absolute left-1.5 top-1/2 cursor-grab text-primary-600 opacity-0 transition-opacity hover:text-primary-400 group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <GripVertical className="h-4 w-4" />
            </button>

            <div className="ml-3">
                <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-xs text-primary-500">#{task.number}</span>
                    <span
                        className={
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                            PRIORITY_COLORS[priority]
                        }
                    >
                        {priority.toUpperCase()}
                    </span>
                </div>

                <h3 className="mb-1.5 line-clamp-2 text-sm font-medium text-primary-200">
                    {task.title}
                </h3>

                <div className="flex items-center justify-between">
                    <span className="text-xs text-primary-500">
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
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-primary-700 text-[10px] text-primary-300">
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
