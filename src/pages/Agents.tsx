import { useAgentTaskHistory, useAgentsStatus } from "../hooks/useAgents";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { formatDate, formatDuration } from "../utils/format";

const statusColors = {
    active: {
        bg: "bg-emerald-400",
        text: "text-emerald-300",
        border: "border-emerald-300/80",
        glow: "shadow-[0_0_6px_rgba(52,211,153,0.75)]",
    },
    thinking: {
        bg: "bg-amber-300",
        text: "text-amber-300",
        border: "border-amber-200/80",
        glow: "shadow-[0_0_6px_rgba(252,211,77,0.7)]",
    },
    idle: {
        bg: "bg-sky-300",
        text: "text-primary-200",
        border: "border-sky-200/80",
        glow: "",
    },
    offline: {
        bg: "bg-primary-500",
        text: "text-primary-500",
        border: "border-primary-400/80",
        glow: "",
    },
} as const;

const statusLabels = {
    active: "Working",
    thinking: "Thinking",
    idle: "Ready",
    offline: "Offline",
} as const;

function StatusIndicator({ status }: { status: keyof typeof statusColors }) {
    const colors = statusColors[status];
    const pulseClass = status === "active" || status === "thinking" ? " animate-pulse" : "";

    return (
        <div
            className={
                "flex h-4 w-4 items-center justify-center rounded-full border ring-1 ring-primary-900/80 " +
                colors.border +
                " " +
                colors.glow +
                pulseClass
            }
        >
            <div className={"h-2.5 w-2.5 rounded-full " + colors.bg} />
        </div>
    );
}

function AgentCard({
    id,
    status,
    model,
    currentTask,
    currentActivity,
    lastActivity,
    channel,
}: {
    id: string;
    status: keyof typeof statusColors;
    model: string;
    currentTask: string | null;
    currentActivity: string | null;
    lastActivity: string | null;
    channel: string | null;
}) {
    const colors = statusColors[status];
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
                    {statusLabels[status]}
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
                        Last active {lastActivity
                            ? formatDuration(new Date(lastActivity).getTime())
                            : "N/A"}
                    </span>
                </div>
            </div>
        </Card>
    );
}

function TaskHistorySidebar() {
    const { data } = useAgentTaskHistory(7);
    const tasks = data?.tasks || [];

    return (
        <div className="space-y-2">
            <div>
                <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Latest Tasks
                </h3>
            </div>

            {tasks.length === 0 ? (
                <p className="text-sm italic text-primary-500">No completed tasks yet</p>
            ) : (
                <div className="relative space-y-2">
                    <span className="absolute bottom-4 left-1.5 top-4 w-px -translate-x-1/2 bg-primary-700/70" />
                    {tasks.map((item) => (
                        <div key={item.id} className="relative flex gap-2.5">
                            <div className="relative w-3 shrink-0">
                                <span className="absolute left-1/2 top-3 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-primary-700 bg-primary-300" />
                            </div>

                            <div className="flex-1 rounded border border-primary-700/80 bg-primary-900/60 p-2.5">
                                <div className="mb-0.5 flex items-center justify-between gap-2">
                                    <span className="text-xs font-medium text-primary-200">{item.agentId}</span>
                                    <span className="text-[11px] text-primary-500">
                                        {item.completedAt ? formatDate(item.completedAt) : "-"}
                                    </span>
                                </div>
                                <p className="text-sm text-primary-100">{item.task}</p>
                                <p className="mt-1 text-[11px] uppercase tracking-wide text-primary-500">
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

export function Agents() {
    const { data, isLoading, error } = useAgentsStatus();

    const agents = data?.agents || [];
    const activeAgents = agents.filter((a) => a.status === "active" || a.status === "thinking");
    const idleAgents = agents.filter((a) => a.status === "idle");
    const offlineAgents = agents.filter((a) => a.status === "offline");

    return (
        <div className="space-y-4 p-6">
            <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
                <Card className="space-y-6">
                    {error && (
                        <div className="rounded-lg bg-red-500/20 p-4 text-red-300">
                            {error instanceof Error ? error.message : "Failed to load agents"}
                        </div>
                    )}

                    {isLoading ? (
                        <div className="flex items-center justify-center py-12">
                            <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent-500" />
                        </div>
                    ) : (
                        <>
                            {activeAgents.length > 0 && (
                                <div>
                                    <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-primary-300">
                                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                                        Active ({activeAgents.length})
                                    </h2>
                                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        {activeAgents.map((agent) => (
                                            <AgentCard
                                                key={agent.id}
                                                id={agent.id}
                                                status={agent.status}
                                                model={agent.model}
                                                currentTask={agent.currentTask}
                                                currentActivity={agent.currentActivity}
                                                lastActivity={agent.lastActivity}
                                                channel={agent.channel}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {idleAgents.length > 0 && (
                                <div>
                                    <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-primary-300">
                                        <span className="h-2 w-2 rounded-full bg-sky-300" />
                                        Idle ({idleAgents.length})
                                    </h2>
                                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        {idleAgents.map((agent) => (
                                            <AgentCard
                                                key={agent.id}
                                                id={agent.id}
                                                status={agent.status}
                                                model={agent.model}
                                                currentTask={agent.currentTask}
                                                currentActivity={agent.currentActivity}
                                                lastActivity={agent.lastActivity}
                                                channel={agent.channel}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {offlineAgents.length > 0 && (
                                <div>
                                    <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-primary-400">
                                        <span className="h-2 w-2 rounded-full bg-primary-600" />
                                        Offline ({offlineAgents.length})
                                    </h2>
                                    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                        {offlineAgents.map((agent) => (
                                            <AgentCard
                                                key={agent.id}
                                                id={agent.id}
                                                status={agent.status}
                                                model={agent.model}
                                                currentTask={agent.currentTask}
                                                currentActivity={agent.currentActivity}
                                                lastActivity={agent.lastActivity}
                                                channel={agent.channel}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}

                            {agents.length === 0 && (
                                <Card className="py-8 text-center">
                                    <p className="text-primary-400">
                                        No agents configured. Check{" "}
                                        <code className="rounded bg-primary-700 px-1 py-0.5 text-primary-300">
                                            ~/.openclaw/config/agents.json5
                                        </code>
                                    </p>
                                </Card>
                            )}
                        </>
                    )}
                </Card>

                <Card className="hidden xl:block">
                    <TaskHistorySidebar />
                </Card>
            </div>
        </div>
    );
}
