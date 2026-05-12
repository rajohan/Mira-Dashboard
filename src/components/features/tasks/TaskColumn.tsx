import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";

import type { ColumnId, Task } from "../../../types/task";
import { COLUMN_CONFIG, type ColumnConfig } from "../../../utils/taskUtils";
import { TaskCard } from "./TaskCard";

interface TaskColumnProps {
    id: ColumnId;
    tasks: Task[];
    isOver: boolean;
    onTaskClick: (task: Task) => void;
}

export function TaskColumn({ id, tasks, isOver, onTaskClick }: TaskColumnProps) {
    const config: ColumnConfig | undefined = COLUMN_CONFIG.find((c) => c.id === id);
    const { setNodeRef } = useDroppable({ id });

    if (!config) return null;

    return (
        <div className="flex min-w-0 flex-col lg:min-w-[280px] lg:flex-1">
            <div className="mb-2 flex items-center gap-2">
                <div className={"h-2 w-2 rounded-full " + config.dotColor} />
                <h2 className="text-primary-300 text-sm font-medium">{config.title}</h2>
                <span className="bg-primary-700/50 text-primary-400 rounded px-1.5 py-0.5 text-xs">
                    {tasks.length}
                </span>
            </div>
            <div
                ref={setNodeRef}
                data-column={id}
                className={
                    "flex min-h-28 flex-col gap-2 rounded-lg border-2 border-dashed p-2 transition-colors lg:min-h-[400px] lg:flex-1 " +
                    (isOver
                        ? "border-accent-500/50 bg-accent-500/5"
                        : "border-primary-700/50 bg-primary-800/30")
                }
            >
                {tasks.length > 0 ? (
                    <SortableContext
                        items={tasks.map((task) => String(task.number))}
                        strategy={verticalListSortingStrategy}
                    >
                        {tasks.map((task) => (
                            <TaskCard
                                key={task.number}
                                task={task}
                                onClick={() => onTaskClick(task)}
                            />
                        ))}
                    </SortableContext>
                ) : (
                    <div className="text-primary-500 flex flex-1 items-center justify-center text-sm">
                        No tasks
                    </div>
                )}
            </div>
        </div>
    );
}
