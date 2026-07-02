import type { Task } from "../../../types/task";
import { getPriority, PRIORITY_COLORS } from "../../../utils/taskUtilities";
import { Badge } from "../../ui/Badge";

/** Renders the task overlay UI. */
export function TaskOverlay({ task }: { task: Task }) {
    const priority = getPriority(task.labels);

    return (
        <div className="w-72 rounded-lg border border-accent-500/50 bg-primary-800 p-3 shadow-xl">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
                <span className="text-xs text-primary-500">#{task.number}</span>
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
            <h3 className="line-clamp-2 text-sm font-medium text-primary-200">
                {task.title}
            </h3>
        </div>
    );
}
