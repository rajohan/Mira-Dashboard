import { useAgentsStatus } from "../hooks/useAgents";
import { Badge } from "../components/ui/Badge";
import { Card } from "../components/ui/Card";
import { formatDuration } from "../utils/format";

const statusColors = {
    active: {
        bg: "bg-emerald-500/20",
        text: "text-emerald-300",
        border: "border-emerald-500/50",
        glow: "animate-pulse shadow-emerald-500/50 shadow-lg",
    },
    thinking: {
        bg: "bg-amber-500/20",
        text: "text-amber-300",
        border: "border-amber-500/50",
        glow: "animate-pulse shadow-amber-500/50 shadow-md",
    },
    idle: {
        bg: "bg-primary-600/50",
        text: "text-primary-300",
        border: "border-primary-500/50",
        glow: "",
    },
    offline: {
        bg: "bg-primary-800/50",
        text: "text-primary-500",
        border: "border-primary-700/50",
        glow: "",
    },
};

const statusLabels = {
    active: "Working",
    thinking: "Thinking",
    idle: "Ready",
    offline: "Offline",
};

function StatusIndicator({ status }: { status: keyof typeof statusColors }) {
    const colors = statusColors[status];
    return (
        <div
            className={
                "flex h-3 w-3 items-center justify-center rounded-full " +
                colors.bg +
                " " +
                colors.border +
                " " +
                colors.glow
            }
        >
            <div className={"h-2 w-2 rounded-full " + colors.bg} />
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
        <Card className="relative overflow-hidden">
            {/* Status glow effect */}
            {status === "active" && (
                <div
                    className={
                        "pointer-events-none absolute inset-0 " +
                        "bg-gradient-to-r from-emerald-500/5 via-transparent to-emerald-500/5"
                    }
                />
            )}

            {/* Header */}
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

            {/* Current Task */}
            {currentTask && (
                <div className="mb-3">
                    <div className="text-xs uppercase tracking-wide text-primary-500">
                        Task
                    </div>
                    <div className={"mt-1 text-sm " + colors.text}>
                        {currentTask}
                    </div>
                </div>
            )}

            {/* Current Activity */}
            {currentActivity && (
                <div className="mb-3">
                    <div className="text-xs uppercase tracking-wide text-primary-500">
                        Activity
                    </div>
                    <div className="mt-1 text-sm text-primary-300">
                        {currentActivity}
                    </div>
                </div>
            )}

            {/* No activity */}
            {!currentTask && !currentActivity && (
                <div className="mb-3">
                    <div className="text-sm italic text-primary-500">
                        No active task
                    </div>
                </div>
            )}

            {/* Footer */}
            <div className="flex items-center justify-between text-xs text-primary-400">
                <div className="flex items-center gap-1">
                    {channel && (
                        <>
                            <span className="rounded bg-primary-700 px-1.5 py-0.5">
                                {channel}
                            </span>
                            <span className="text-primary-600">•</span>
                        </>
                    )}
                    <span>
                        {lastActivity
                            ? formatDuration(new Date(lastActivity).getTime())
                            : "Never"}
                    </span>
                </div>
                <span className="text-primary-500">
                    {modelShort.includes(":") ? modelShort.split(":")[0] : modelShort}
                </span>
            </div>
        </Card>
    );
}

export function Agents() {
    const { data, isLoading, error } = useAgentsStatus();

    const agents = data?.agents || [];

    // Group agents by status
    const activeAgents = agents.filter((a) => a.status === "active" || a.status === "thinking");
    const idleAgents = agents.filter((a) => a.status === "idle");
    const offlineAgents = agents.filter((a) => a.status === "offline");

    return (
        <div className="p-6">
            <div className="mb-6">
                <h1 className="text-2xl font-bold text-primary-50">Agents</h1>
                <p className="text-sm text-primary-400">
                    Real-time status of configured agents
                </p>
            </div>

            {error && (
                <div className="mb-4 rounded-lg bg-red-500/20 p-4 text-red-300">
                    {error instanceof Error ? error.message : "Failed to load agents"}
                </div>
            )}

            {isLoading ? (
                <div className="flex items-center justify-center py-12">
                    <div className="h-8 w-8 animate-spin rounded-full border-b-2 border-accent-500" />
                </div>
            ) : (
                <>
                    {/* Active Agents */}
                    {activeAgents.length > 0 && (
                        <div className="mb-8">
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

                    {/* Idle Agents */}
                    {idleAgents.length > 0 && (
                        <div className="mb-8">
                            <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-primary-300">
                                <span className="h-2 w-2 rounded-full bg-primary-400" />
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

                    {/* Offline Agents */}
                    {offlineAgents.length > 0 && (
                        <div className="mb-8">
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

                    {agents.length === 0 && !isLoading && (
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
        </div>
    );
}