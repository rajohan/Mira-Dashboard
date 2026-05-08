import { useAgentTaskHistory } from "../../../hooks/useAgents";
import { formatDate } from "../../../utils/format";

export function TaskHistorySidebar() {
    const { data } = useAgentTaskHistory(7);
    const tasks = data?.tasks || [];

    return (
        <div className="min-w-0 space-y-2">
            <div>
                <h3 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Latest Tasks
                </h3>
            </div>

            {tasks.length === 0 ? (
                <p className="text-primary-500 text-sm italic">No completed tasks yet</p>
            ) : (
                <div className="relative space-y-2">
                    <span className="bg-primary-700/70 absolute top-4 bottom-4 left-1.5 w-px -translate-x-1/2" />
                    {tasks.map((item) => (
                        <div key={item.id} className="relative flex gap-2.5">
                            <div className="relative w-3 shrink-0">
                                <span className="border-primary-700 bg-primary-300 absolute top-3 left-1/2 h-2.5 w-2.5 -translate-x-1/2 rounded-full border" />
                            </div>

                            <div className="border-primary-700/80 bg-primary-900/60 min-w-0 flex-1 rounded border p-2.5">
                                <div className="mb-0.5 flex flex-col gap-0.5 sm:flex-row sm:items-center sm:justify-between sm:gap-2">
                                    <span className="text-primary-200 truncate text-xs font-medium">
                                        {item.agentId}
                                    </span>
                                    <span className="text-primary-500 shrink-0 text-[11px]">
                                        {item.completedAt
                                            ? formatDate(item.completedAt)
                                            : "-"}
                                    </span>
                                </div>
                                <p className="text-primary-100 text-sm break-words">
                                    {item.task}
                                </p>
                                <p className="text-primary-500 mt-1 text-[11px] tracking-wide uppercase">
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
