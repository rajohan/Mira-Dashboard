import {
    Bot,
    CircleAlert,
    CircleCheck,
    LoaderCircle,
    type LucideIcon,
} from "lucide-react";

import type { AgentDefinition, AgentStatus } from "../../contracts/agentModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface AgentStatusCardProps {
    readonly agent: AgentDefinition;
    readonly status: AgentStatus | undefined;
}

interface AgentStatusAppearance {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly variant: "default" | "success" | "warning";
}

function agentStatusAppearance(status: AgentStatus | undefined): AgentStatusAppearance {
    if (status === undefined) {
        return { icon: CircleAlert, label: "unavailable", variant: "warning" };
    }
    if (status.state === "working") {
        return { icon: LoaderCircle, label: "working", variant: "success" };
    }
    return { icon: CircleCheck, label: "idle", variant: "default" };
}

function AgentStatusDetail({ status }: Pick<AgentStatusCardProps, "status">) {
    if (status === undefined) {
        return (
            <Text className="border-primary-700 mt-4 border-t pt-4" tone="muted">
                Current status was not returned
            </Text>
        );
    }
    if (status.state === "working") {
        return (
            <div className="border-primary-700 mt-4 border-t pt-4">
                <Text className="wrap-break-word" tone="accent">
                    {status.currentTask}
                </Text>
                <Text className="mt-2" size="sm" tone="muted">
                    Started {formatDashboardDateTime(status.startedAtMs)}
                </Text>
            </div>
        );
    }
    return (
        <Text className="border-primary-700 mt-4 border-t pt-4" tone="muted">
            {status.lastActivityAtMs === undefined
                ? "No recorded task activity"
                : `Last active ${formatDashboardDateTime(status.lastActivityAtMs)}`}
        </Text>
    );
}

function AgentStatusCard({ agent, status }: AgentStatusCardProps) {
    const appearance = agentStatusAppearance(status);
    return (
        <Card aria-labelledby={`agent-${agent.id}-heading`}>
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                    <span className="bg-primary-700 text-accent-300 rounded-lg p-2">
                        <Icon icon={Bot} tone="inherit" />
                    </span>
                    <div className="min-w-0">
                        <Heading
                            id={`agent-${agent.id}-heading`}
                            level={2}
                            size="subsection"
                        >
                            {agent.displayName}
                        </Heading>
                        <Text size="sm" tone="muted">
                            {agent.id} · {agent.role}
                        </Text>
                    </div>
                </div>
                <Badge variant={appearance.variant}>
                    <Icon icon={appearance.icon} size="sm" tone="inherit" />
                    {appearance.label}
                </Badge>
            </div>
            <Text className="mt-4" size="sm">
                {agent.description}
            </Text>
            <AgentStatusDetail status={status} />
        </Card>
    );
}

interface AgentStatusGridProps {
    readonly agents: readonly AgentDefinition[];
    readonly statuses: readonly AgentStatus[];
}

/** @returns Current status cards joined to the reviewed agent directory. */
export function AgentStatusGrid({ agents, statuses }: AgentStatusGridProps) {
    const statusesById = new Map(statuses.map((status) => [status.agentId, status]));
    return (
        <section aria-labelledby="agent-status-heading">
            <Heading id="agent-status-heading" level={2}>
                Current status
            </Heading>
            <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
                {agents.map((agent) => (
                    <AgentStatusCard
                        agent={agent}
                        key={agent.id}
                        status={statusesById.get(agent.id)}
                    />
                ))}
            </div>
        </section>
    );
}
