import { TaskCard } from "./TaskCard";
import { COLUMN_CONFIG, type ColumnConfig } from "./taskUtils";

import type { Task, ColumnId } from "../../../types/task";

interface TaskColumnProps {
    id: ColumnId;
    tasks: Task[];
    isOver: boolean;
    onTaskClick: (task: Task) => void;
}

export function TaskColumn({ id, tasks, isOver, onTaskClick }: TaskColumnProps) {
    const config: ColumnConfig | undefined = COLUMN_CONFIG.find((c) => c.id === id);

    if (!config) return null;

    return (
        <div className="flex min-w-[280px] flex-1 flex-col">
            <div className="mb-2 flex items-center gap-2">
                <div className={"h-2 w-2 rounded-full " + config.dotColor} />
                <h2 className="text-sm font-medium text-slate-300">{config.title}</h2>
                <span className="rounded bg-slate-700/50 px-1.5 py-0.5 text-xs text-slate-400">
                    {tasks.length}
                </span>
            </div>
            <div
                data-column={id}
                className={
                    "flex min-h-[400px] flex-1 flex-col gap-2 rounded-lg border-2 border-dashed p-2 transition-colors " +
                    (isOver
                        ? "border-accent-500/50 bg-accent-500/5"
                        : "border-slate-700/50 bg-slate-800/30")
                }
            >
                {tasks.length > 0 ? (
                    tasks.map((task) => (
                        <TaskCard
                            key={task.number}
                            task={task}
                            onClick={() => onTaskClick(task)}
                        />
                    ))
                ) : (
                    <div className="flex flex-1 items-center justify-center text-sm text-slate-500">
                        No tasks
                    </div>
                )}
            </div>
        </div>
    );
}