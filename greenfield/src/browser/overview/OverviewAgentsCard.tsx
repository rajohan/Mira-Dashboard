import { Bot } from "lucide-react";
import { useId } from "react";

import type { AgentDefinition, AgentStatus } from "../../contracts/agentModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

export interface OverviewAgentsCardProps {
    readonly agents: readonly AgentDefinition[];
    readonly statuses: readonly AgentStatus[];
}

/**
 * Renders the complete bounded Dashboard-owned current-task projection.
 * @param properties Reviewed agent directory and current statuses.
 * @returns Read-only agent activity overview with current tasks.
 */
export function OverviewAgentsCard({ agents, statuses }: OverviewAgentsCardProps) {
    const headingId = useId();
    const workingHeadingId = useId();
    const configuredAgentIds = new Set(agents.map(({ id }) => id));
    const configuredStatuses = statuses.filter(({ agentId }) =>
        configuredAgentIds.has(agentId)
    );
    const workingStatuses = configuredStatuses.filter(
        (status): status is Extract<AgentStatus, { readonly state: "working" }> =>
            status.state === "working"
    );
    const idleCount = configuredStatuses.filter(({ state }) => state === "idle").length;
    const missingProjectionCount = Math.max(0, agents.length - configuredStatuses.length);
    const agentsById = new Map(agents.map((agent) => [agent.id, agent]));

    return (
        <Card aria-labelledby={headingId} className="h-full">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="bg-accent-500/10 shrink-0 rounded-lg p-2.5">
                        <Icon icon={Bot} tone="accent" />
                    </span>
                    <div className="min-w-0">
                        <Heading id={headingId} level={2} size="subsection">
                            Agent activity
                        </Heading>
                        <Text className="mt-1" size="sm" tone="muted">
                            Dashboard-owned current tasks from the latest paired
                            projections. Gateway presence and sessions are not included.
                        </Text>
                    </div>
                </div>
                <ActionLink size="sm" to="/agents" variant="secondary">
                    View agents
                </ActionLink>
            </div>

            <dl className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-2">
                {[
                    ["Configured", agents.length],
                    ["Working", workingStatuses.length],
                    ["Idle", idleCount],
                    ["Missing projection", missingProjectionCount],
                ].map(([label, value]) => (
                    <div
                        className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                        key={label}
                    >
                        <dt className="text-primary-400 text-xs">{label}</dt>
                        <dd className="text-primary-50 mt-2 text-2xl font-semibold tabular-nums">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>

            {workingStatuses.length === 0 ? (
                <div className="border-primary-700 bg-primary-900/35 mt-4 rounded-lg border p-4">
                    <Text>
                        {idleCount === agents.length
                            ? "All configured agents are idle."
                            : "No configured agent currently reports working; one or more status projections are missing."}
                    </Text>
                </div>
            ) : (
                <section aria-labelledby={workingHeadingId} className="mt-4">
                    <Heading id={workingHeadingId} level={3}>
                        Working now
                    </Heading>
                    <ul className="mt-3 space-y-3">
                        {workingStatuses.map((status) => (
                            <li
                                className="border-primary-700 bg-primary-900/35 rounded-lg border p-3"
                                key={status.agentId}
                            >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <Text className="font-medium">
                                        {agentsById.get(status.agentId)?.displayName ??
                                            status.agentId}
                                    </Text>
                                    <Badge variant="success">working</Badge>
                                </div>
                                <Text
                                    className="mt-2 line-clamp-2 wrap-break-word"
                                    tone="accent"
                                >
                                    {status.currentTask}
                                </Text>
                                <time
                                    className="text-primary-400 mt-2 block text-xs"
                                    dateTime={new Date(status.startedAtMs).toISOString()}
                                >
                                    Started {formatDashboardDateTime(status.startedAtMs)}
                                </time>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
        </Card>
    );
}
