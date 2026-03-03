import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { formatDistanceToNow } from "date-fns";
import { enUS } from "date-fns/locale";
import { GripVertical } from "lucide-react";

import type { Task } from "../../../types/task";
import { getPriority } from "../../../utils/taskUtils";

interface TaskCardProps {
    task: Task;
    isDragging?: boolean;
    onClick: () => void;
}

const PRIORITY_COLORS: Record<string, string> = {
    high: "bg-red-500/20 text-red-400 border-red-500/30",
    medium: "bg-purple-500/20 text-purple-400 border-purple-500/30",
    low: "bg-slate-500/20 text-slate-400 border-slate-500/30",
};

export function TaskCard({ task, isDragging, onClick }: TaskCardProps) {
    const { attributes, listeners, setNodeRef, transform } = useSortable({
        id: `task-${task.number}`,
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
                "group relative cursor-pointer rounded-lg border border-slate-700 bg-slate-800 p-3 transition-all " +
                "hover:border-slate-600 " +
                (isDragging ? "cursor-grabbing border-accent-500 opacity-90" : "")
            }
            onClick={onClick}
        >
            <button
                {...listeners}
                className="absolute left-1.5 top-1/2 -translate-y-1/2 cursor-grab text-slate-600 opacity-0 transition-opacity hover:text-slate-400 group-hover:opacity-100"
                onClick={(e) => e.stopPropagation()}
            >
                <GripVertical className="h-4 w-4" />
            </button>

            <div className="ml-3">
                <div className="mb-1.5 flex items-center gap-2">
                    <span className="text-xs text-slate-500">#{task.number}</span>
                    <span
                        className={
                            "rounded border px-1.5 py-0.5 text-[10px] font-medium " +
                            PRIORITY_COLORS[priority]
                        }
                    >
                        {priority.toUpperCase()}
                    </span>
                </div>

                <h3 className="mb-1.5 line-clamp-2 text-sm font-medium text-slate-200">
                    {task.title}
                </h3>

                <div className="flex items-center justify-between">
                    <span className="text-xs text-slate-500">
                        {formatDistanceToNow(new Date(task.updatedAt), {
                            addSuffix: true,
                            locale: enUS,
                        })}
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
                                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-slate-700 text-[10px] text-slate-300">
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
