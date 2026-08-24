import {
    Bot,
    CircleAlert,
    CircleCheck,
    CircleHelp,
    Link2,
    LoaderCircle,
    Unplug,
    type LucideIcon,
} from "lucide-react";

import {
    type AgentDefinition,
    type AgentStatusProjection,
    isWorkingAgentStatusProjection,
} from "../../contracts/agentModel.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";

interface AgentStatusCardProps {
    readonly agent: AgentDefinition;
    readonly status: AgentStatusProjection | undefined;
}

interface AgentStatusAppearance {
    readonly icon: LucideIcon;
    readonly label: string;
    readonly variant: "default" | "success" | "warning";
}

function agentStatusAppearance(
    status: AgentStatusProjection | undefined
): AgentStatusAppearance {
    if (status === undefined) {
        return { icon: CircleAlert, label: "unavailable", variant: "warning" };
    }
    if (isWorkingAgentStatusProjection(status)) {
        return { icon: LoaderCircle, label: "working", variant: "success" };
    }
    return { icon: CircleCheck, label: "idle", variant: "default" };
}

function gatewayAvailabilityAppearance(
    status: AgentStatusProjection | undefined
): AgentStatusAppearance {
    switch (status?.gatewayAvailability) {
        case "active": {
            return { icon: LoaderCircle, label: "active", variant: "success" };
        }
        case "idle": {
            return { icon: Link2, label: "idle", variant: "default" };
        }
        case "stale": {
            return { icon: CircleAlert, label: "stale", variant: "warning" };
        }
        case "unknown": {
            return { icon: CircleHelp, label: "unknown", variant: "default" };
        }
        case "disconnected":
        case undefined: {
            return { icon: Unplug, label: "disconnected", variant: "warning" };
        }
    }
}

function missingGatewaySessionMessage(status: AgentStatusProjection): string {
    if (status.gatewayAvailability === "unknown") {
        return "No matching session appears in the bounded fresh snapshot.";
    }
    return "No matching last-known session is available while Gateway is disconnected.";
}

function GatewayAvailabilityMetadata({ status }: Pick<AgentStatusCardProps, "status">) {
    if (status === undefined) {
        return (
            <Text className="mt-2" size="sm" tone="muted">
                No paired status projection was returned.
            </Text>
        );
    }
    if (status.sessionKey === undefined) {
        return (
            <Text className="mt-2" size="sm" tone="muted">
                {missingGatewaySessionMessage(status)}
            </Text>
        );
    }
    return (
        <dl className="mt-2 space-y-1 text-sm">
            <div className="flex flex-wrap gap-x-2">
                <dt className="text-primary-400">Session</dt>
                <dd className="text-primary-200 wrap-break-word">{status.sessionKey}</dd>
            </div>
            {status.providerModel !== undefined && (
                <div className="flex flex-wrap gap-x-2">
                    <dt className="text-primary-400">Provider/model</dt>
                    <dd className="text-primary-200 wrap-break-word">
                        {status.providerModel}
                    </dd>
                </div>
            )}
            {status.lastSeenAtMs !== undefined && (
                <div className="flex flex-wrap gap-x-2">
                    <dt className="text-primary-400">Last seen</dt>
                    <dd className="text-primary-200">
                        <time dateTime={new Date(status.lastSeenAtMs).toISOString()}>
                            {formatDashboardDateTime(status.lastSeenAtMs)}
                        </time>
                    </dd>
                </div>
            )}
        </dl>
    );
}

function AgentStatusDetail({ status }: Pick<AgentStatusCardProps, "status">) {
    if (status === undefined) {
        return (
            <Text className="border-primary-700 mt-4 border-t pt-4" tone="muted">
                Current status was not returned
            </Text>
        );
    }
    if (isWorkingAgentStatusProjection(status)) {
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

function GatewayAvailabilityDetail({ status }: Pick<AgentStatusCardProps, "status">) {
    const appearance = gatewayAvailabilityAppearance(status);
    return (
        <div className="border-primary-700 mt-4 border-t pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <Text className="font-medium" size="sm">
                    Gateway session
                </Text>
                <Badge
                    aria-label={`Gateway session availability: ${appearance.label}`}
                    variant={appearance.variant}
                >
                    <Icon icon={appearance.icon} size="sm" tone="inherit" />
                    {appearance.label}
                </Badge>
            </div>
            <GatewayAvailabilityMetadata status={status} />
        </div>
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
                            level={3}
                            size="subsection"
                        >
                            {agent.displayName}
                        </Heading>
                        <Text size="sm" tone="muted">
                            {agent.id} · {agent.role}
                        </Text>
                    </div>
                </div>
                <Badge
                    aria-label={`Dashboard task state: ${appearance.label}`}
                    variant={appearance.variant}
                >
                    <Icon icon={appearance.icon} size="sm" tone="inherit" />
                    {appearance.label}
                </Badge>
            </div>
            <Text className="mt-4" size="sm">
                {agent.description}
            </Text>
            <AgentStatusDetail status={status} />
            <GatewayAvailabilityDetail status={status} />
        </Card>
    );
}

interface AgentStatusGridProps {
    readonly agents: readonly AgentDefinition[];
    readonly statuses: readonly AgentStatusProjection[];
}

/** @returns Current status cards joined to the reviewed agent directory. */
export function AgentStatusGrid({ agents, statuses }: AgentStatusGridProps) {
    const statusesById = new Map(statuses.map((status) => [status.agentId, status]));
    return (
        <section aria-labelledby="agent-status-heading">
            <Heading id="agent-status-heading" level={2}>
                Current status
            </Heading>
            <Text className="mt-2" size="sm" tone="muted">
                Dashboard task state and Gateway session availability are separate.
                Gateway availability is not online status or health.
            </Text>
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
