import { useAgentTaskHistory } from "../../../hooks/useAgents";
import { formatDate } from "../../../utils/format";

/** Renders the task history sidebar UI. */
export function TaskHistorySidebar() {
    const { data } = useAgentTaskHistory(7);
    const tasks = data?.tasks || [];

    return (
        <div className="min-w-0 space-y-2">
            <div>
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Latest Tasks
                </h3>
            </div>

            {tasks.length === 0 ? (
                <p className="text-sm text-primary-500 italic">No completed tasks yet</p>
            ) : (
                <div className="relative space-y-2">
                    <span className="absolute inset-y-4 left-1.5 w-px -translate-x-1/2 bg-primary-700/70" />
                    {tasks.map((item) => (
                        <div key={item.id} className="relative flex gap-2.5">
                            <div className="relative w-3 shrink-0">
                                <span className="absolute top-3 left-1/2 size-2.5 -translate-x-1/2 rounded-full border border-primary-700 bg-primary-300" />
                            </div>

                            <div className="min-w-0 flex-1 rounded border border-primary-700/80 bg-primary-900/60 p-2.5">
                                <div className="mb-0.5 flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                                    <span className="truncate text-xs font-medium text-primary-200">
                                        {item.agentId}
                                    </span>
                                    <span className="shrink-0 text-[11px] text-primary-500">
                                        {item.completedAt
                                            ? formatDate(item.completedAt)
                                            : "-"}
                                    </span>
                                </div>
                                <p className="text-sm wrap-break-word text-primary-100">
                                    {item.task}
                                </p>
                                <p className="mt-1 text-[11px] tracking-wide text-primary-500 uppercase">
                                    {item.status}
                                </p>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );
}
