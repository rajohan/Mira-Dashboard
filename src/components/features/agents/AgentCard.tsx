import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";
import { formatDuration } from "../../../utils/format";
import { agentStatusColors, agentStatusLabels } from "./status";
import { StatusIndicator } from "./StatusIndicator";

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
        <Card className="relative flex h-full flex-col overflow-hidden border border-primary-700 bg-primary-900">
            <div className="mb-4 flex items-start justify-between">
                <div className="flex items-center gap-3">
                    <StatusIndicator status={status} />
                    <div>
                        <h3 className="font-semibold text-primary-50">{id}</h3>
                        <p className="text-xs text-primary-400">{modelShort}</p>
                    </div>
                </div>
                <Badge
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
                    <div className="text-xs uppercase tracking-wide text-primary-500">Task</div>
                    <div className={"mt-1 text-sm " + colors.text}>{currentTask}</div>
                </div>
            )}

            {currentActivity && (
                <div className="mb-3">
                    <div className="text-xs uppercase tracking-wide text-primary-500">Activity</div>
                    <div className="mt-1 text-sm text-primary-300">{currentActivity}</div>
                </div>
            )}

            {!currentTask && !currentActivity && (
                <div className="mb-3">
                    <div className="text-sm italic text-primary-500">No active task</div>
                </div>
            )}

            <div className="mt-auto flex items-center justify-between text-xs text-primary-400">
                <div className="flex items-center gap-1">
                    {channel && (
                        <>
                            <span className="rounded bg-primary-700 px-1.5 py-0.5">{channel}</span>
                            <span className="text-primary-600">•</span>
                        </>
                    )}
                    <span>
                        Last active {lastActivity ? formatDuration(new Date(lastActivity).getTime()) : "N/A"}
                    </span>
                </div>
            </div>
        </Card>
    );
}
