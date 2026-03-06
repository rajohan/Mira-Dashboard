import { useAgentsStatus } from "../hooks/useAgents";
import { useTasks } from "../hooks/useTasks";
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

function TaskSidebar() {
    const { data: tasks } = useTasks();
    const recentTasks = (tasks || []).slice(0, 5);

    return (
        <Card className="sticky top-6">
            <h3 className="mb-4 text-sm font-semibold uppercase tracking-wide text-primary-300">
                Latest Tasks
            </h3>
            {recentTasks.length === 0 ? (
                <p className="text-sm text-primary-500 italic">No tasks</p>
            ) : (
                <div className="space-y-3">
                    {recentTasks.map((task) => (
                        <div key={task.id} className="rounded bg-primary-800/50 p-3">
                            <div className="flex items-start justify-between gap-2">
                                <div className="flex-1 min-w-0">
                                    <p className="text-sm font-medium text-primary-100 truncate">
                                        {task.title}
                                    </p>
                                    {task.description && (
                                        <p className="mt-1 text-xs text-primary-400 overflow-hidden" style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' }}>
                                            {task.description}
                                        </p>
                                    )}
                                </div>
                                {task.status && (
                                    <Badge
                                        variant={
                                            task.status === "done"
                                                ? "success"
                                                : task.status === "in-progress"
                                                  ? "warning"
                                                  : "default"
                                        }
                                        className="shrink-0"
                                    >
                                        {task.status}
                                    </Badge>
                                )}
                            </div>
                            {task.labels && task.labels.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-1">
                                    {task.labels.slice(0, 3).map((label: { name?: string; color?: string }) => (
                                        <span
                                            key={label.name}
                                            className="rounded px-1.5 py-0.5 text-xs"
                                            style={{
                                                backgroundColor: label.color
                                                    ? `${label.color}20`
                                                    : "rgba(255,255,255,0.1)",
                                                color: label.color || "#fff",
                                            }}
                                        >
                                            {label.name}
                                        </span>
                                    ))}
                                </div>
                            )}
                        </div>
                    ))}
                </div>
            )}
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
        <div className="flex gap-6">
            {/* Main content */}
            <div className="flex-1 space-y-6">
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
                        {/* Active Agents */}
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

                        {/* Idle Agents */}
                        {idleAgents.length > 0 && (
                            <div>
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

            {/* Sidebar - Latest Tasks */}
            <div className="hidden w-80 shrink-0 xl:block">
                <TaskSidebar />
            </div>
        </div>
    );
}