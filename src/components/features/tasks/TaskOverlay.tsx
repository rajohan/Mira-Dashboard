import type { Task } from "../../../types/task";
import { getPriority, PRIORITY_COLORS } from "../../../utils/taskUtils";

export function TaskOverlay({ task }: { task: Task }) {
    const priority = getPriority(task.labels);

    return (
        <div className="w-72 rounded-lg border border-accent-500/50 bg-slate-800 p-3 shadow-xl">
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
            <h3 className="line-clamp-2 text-sm font-medium text-slate-200">
                {task.title}
            </h3>
        </div>
    );
}
