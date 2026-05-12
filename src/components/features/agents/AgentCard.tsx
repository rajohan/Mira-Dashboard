import { formatDuration } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { agentStatusColors, agentStatusLabels } from "./status";
import { StatusIndicator } from "./StatusIndicator";

/** Renders the agent card UI. */
export function AgentCard({
    id,
    status,
    model,
    currentTask,
    currentActivity,
    lastActivity,
    channel,
}: {
    id: string;
    status: keyof typeof agentStatusColors;
    model: string;
    currentTask: string | null;
    currentActivity: string | null;
    lastActivity: string | null;
    channel: string | null;
}) {
    const colors = agentStatusColors[status];
    const modelShort = model.split("/").pop() || model;

    return (
        <Card className="border-primary-700 bg-primary-900 relative flex h-full flex-col overflow-hidden border">
            <div className="mb-4 flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                    <StatusIndicator status={status} />
                    <div className="min-w-0">
                        <h3 className="text-primary-50 truncate font-semibold">{id}</h3>
                        <p className="text-primary-400 truncate text-xs">{modelShort}</p>
                    </div>
                </div>
                <Badge
                    className="shrink-0"
                    variant={
                        status === "active"
                            ? "success"
                            : status === "thinking"
                              ? "warning"
                              : "default"
                    }
                >
                    {agentStatusLabels[status]}
                </Badge>
            </div>

            {currentTask && (
                <div className="mb-3">
                    <div className="text-primary-500 text-xs tracking-wide uppercase">
                        Task
                    </div>
                    <div className={"mt-1 text-sm break-words " + colors.text}>
                        {currentTask}
                    </div>
                </div>
            )}

            {currentActivity && (
                <div className="mb-3">
                    <div className="text-primary-500 text-xs tracking-wide uppercase">
                        Activity
                    </div>
                    <div className="text-primary-300 mt-1 text-sm break-words">
                        {currentActivity}
                    </div>
                </div>
            )}

            {!currentTask && !currentActivity && (
                <div className="mb-3">
                    <div className="text-primary-500 text-sm italic">No active task</div>
                </div>
            )}

            <div className="text-primary-400 mt-auto flex items-center justify-between text-xs">
                <div className="flex min-w-0 flex-wrap items-center gap-1">
                    {channel && (
                        <>
                            <span className="bg-primary-700 max-w-full truncate rounded px-1.5 py-0.5">
                                {channel}
                            </span>
                            <span className="text-primary-600">•</span>
                        </>
                    )}
                    <span className="min-w-0 truncate">
                        Last active{" "}
                        {lastActivity
                            ? formatDuration(new Date(lastActivity).getTime())
                            : "N/A"}
                    </span>
                </div>
            </div>
        </Card>
    );
}
