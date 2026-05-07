import { AgentCard } from "../components/features/agents/AgentCard";
import { TaskHistorySidebar } from "../components/features/agents/TaskHistorySidebar";
import { Card } from "../components/ui/Card";
import { LoadingState } from "../components/ui/LoadingState";
import { useAgentsStatus } from "../hooks/useAgents";

export function Agents() {
    const { data, isLoading, error } = useAgentsStatus();

    const agents = data?.agents || [];
    const activeAgents = agents.filter(
        (a) => a.status === "active" || a.status === "thinking"
    );
    const idleAgents = agents.filter((a) => a.status === "idle");
    const offlineAgents = agents.filter((a) => a.status === "offline");

    return (
        <div className="space-y-4 p-3 sm:p-4 lg:p-6">
            <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_360px] xl:gap-6">
                <Card className="space-y-5 sm:space-y-6">
                    {error && (
                        <div className="rounded-lg bg-red-500/20 p-4 text-red-300">
                            {error instanceof Error
                                ? error.message
                                : "Failed to load agents"}
                        </div>
                    )}

                    {isLoading ? (
                        <LoadingState size="lg" message="Loading agents..." />
                    ) : (
                        <>
                            {activeAgents.length > 0 && (
                                <div>
                                    <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-primary-300">
                                        <span className="h-2 w-2 rounded-full bg-emerald-500" />
                                        Active ({activeAgents.length})
                                    </h2>
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
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
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
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
                                    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 lg:gap-4">
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
                                            ~/.openclaw/openclaw.json
                                        </code>
                                    </p>
                                </Card>
                            )}
                        </>
                    )}
                </Card>

                <Card>
                    <TaskHistorySidebar />
                </Card>
            </div>
        </div>
    );
}
