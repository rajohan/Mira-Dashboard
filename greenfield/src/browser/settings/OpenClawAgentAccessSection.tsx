import { ShieldCheck } from "lucide-react";
import { useState } from "react";

import type {
    OpenClawAgentAccessValue,
    OpenClawAgentToolAccessValue,
    OpenClawConfigurationUpdate,
} from "../../contracts/openClawSettings.ts";
import { cn } from "../lib/classNames.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Input } from "../ui/Input.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";

type AgentToolId = OpenClawAgentToolAccessValue["id"];
type AgentToolOverride = OpenClawAgentToolAccessValue["override"];

interface ToolPresentation {
    readonly description: string;
    readonly label: string;
}

const toolPresentation = Object.freeze({
    automations: {
        description: "Create and manage OpenClaw automations and schedules.",
        label: "Automations",
    },
    browser: {
        description: "Control browser pages and inspect web interfaces.",
        label: "Browser automation",
    },
    edit: { description: "Apply precise edits to existing files.", label: "File edit" },
    exec: { description: "Execute commands in an authorized runtime.", label: "Exec" },
    gateway: {
        description:
            "Read or change OpenClaw Gateway configuration and lifecycle controls, including restart-capable operations.",
        label: "Gateway",
    },
    image: { description: "Analyze images and screenshots.", label: "Image analysis" },
    image_generate: {
        description: "Generate or edit images through configured providers.",
        label: "Image generation",
    },
    memory_search: {
        description: "Search the agent's configured memory sources.",
        label: "Memory search",
    },
    message: {
        description: "Send messages through configured communication providers.",
        label: "Messaging",
    },
    music_generate: {
        description: "Generate music through configured providers.",
        label: "Music generation",
    },
    nodes: { description: "Interact with paired devices and nodes.", label: "Nodes" },
    read: { description: "Read files in authorized workspaces.", label: "File read" },
    sessions_history: {
        description: "Read sanitized history from visible sessions.",
        label: "Session history",
    },
    sessions_list: {
        description: "List sessions visible to the selected agent.",
        label: "Session list",
    },
    tts: { description: "Generate speech audio from text.", label: "Text to speech" },
    video_generate: {
        description: "Generate video through configured providers.",
        label: "Video generation",
    },
    web_fetch: { description: "Fetch bounded content from URLs.", label: "Web fetch" },
    web_search: {
        description: "Search the web through configured providers.",
        label: "Web search",
    },
    write: { description: "Create or overwrite authorized files.", label: "File write" },
} satisfies Readonly<Record<AgentToolId, ToolPresentation>>);

const overrideOptions = Object.freeze([
    {
        label: "Inherit root policy",
        value: "inherit",
    },
    {
        label: "Allow",
        value: "allow",
    },
    {
        label: "Deny",
        value: "deny",
    },
] satisfies readonly SelectOption<AgentToolOverride>[]);

type ToolRisk = "critical" | "elevated" | "read" | "standard";
const toolRisk: Readonly<Record<AgentToolId, ToolRisk>> = Object.freeze({
    automations: "elevated",
    browser: "standard",
    edit: "elevated",
    exec: "elevated",
    gateway: "critical",
    image: "standard",
    image_generate: "standard",
    memory_search: "read",
    message: "elevated",
    music_generate: "standard",
    nodes: "elevated",
    read: "read",
    sessions_history: "standard",
    sessions_list: "standard",
    tts: "standard",
    video_generate: "standard",
    web_fetch: "read",
    web_search: "read",
    write: "elevated",
});
const riskLabels: Readonly<Record<ToolRisk, string>> = Object.freeze({
    critical: "Critical",
    elevated: "Elevated",
    read: "Read-only",
    standard: "Standard",
});
const riskStyles: Readonly<Record<ToolRisk, string>> = Object.freeze({
    critical: "border-red-500/20 bg-red-500/5 text-red-300",
    elevated: "border-amber-500/20 bg-amber-500/5 text-amber-300",
    read: "border-emerald-500/20 bg-emerald-500/5 text-emerald-300",
    standard: "border-blue-500/20 bg-blue-500/5 text-blue-300",
});

interface OpenClawAgentAccessSectionProps {
    readonly activeAgentId: string;
    readonly agents: readonly OpenClawAgentAccessValue[];
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly onSave: (update: OpenClawConfigurationUpdate) => Promise<void>;
    readonly onSelectAgent: (agentId: string) => void;
    readonly truncated: boolean;
}

function agentLabel({ id, name }: OpenClawAgentAccessValue): string {
    return name === undefined || name === id ? id : `${name} (${id})`;
}

/** @returns One-intent controls for exact agent-level core-tool overrides. */
export function OpenClawAgentAccessSection({
    activeAgentId,
    agents,
    busy,
    disabled,
    onSave,
    onSelectAgent,
    truncated,
}: OpenClawAgentAccessSectionProps) {
    const [toolFilter, setToolFilter] = useState("");
    const activeAgent = agents.find(({ id }) => id === activeAgentId) ?? agents[0];
    const normalizedFilter = toolFilter.trim().toLowerCase();

    return (
        <section aria-busy={busy || undefined} aria-label="Agent access control">
            <ExpandableCard
                compact
                icon={ShieldCheck}
                title={
                    <Heading
                        id="openclaw-agent-access-heading"
                        level={2}
                        size="subsection"
                    >
                        Agent access control
                    </Heading>
                }
                trailing={
                    busy ? (
                        <output>
                            <Badge variant="info">Saving override…</Badge>
                        </output>
                    ) : undefined
                }
            >
                {truncated && (
                    <Alert
                        className="mt-4"
                        focusOnError={false}
                        message="Some OpenClaw agent entries could not enter this canonical bounded view. Only the reported rows can be changed here."
                        variant="info"
                    />
                )}

                {agents.length === 0 || activeAgent === undefined ? (
                    <EmptyState
                        className="bg-primary-900/45 mt-5 border-0 shadow-none"
                        description="No canonical configured OpenClaw agents were available for this bounded view."
                        headingLevel={3}
                        title="No agent access reported"
                    />
                ) : (
                    <div className="mt-5 grid gap-5">
                        <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
                            {agents.map((agent) => (
                                <button
                                    aria-pressed={activeAgent.id === agent.id}
                                    className={cn(
                                        "rounded-xl border p-3 text-left transition sm:px-4",
                                        activeAgent.id === agent.id
                                            ? "border-accent-500 bg-accent-500/10 text-accent-200"
                                            : "border-primary-700 bg-primary-900/40 text-primary-300 hover:border-primary-600"
                                    )}
                                    key={agent.id}
                                    onClick={() => onSelectAgent(agent.id)}
                                    type="button"
                                >
                                    <div className="font-medium">
                                        {agent.name ?? agent.id}
                                    </div>
                                    {agent.name !== undefined &&
                                        agent.name !== agent.id && (
                                            <div className="mt-1 text-xs opacity-75">
                                                {agent.id}
                                            </div>
                                        )}
                                </button>
                            ))}
                        </div>

                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <h3 className="text-primary-100 text-lg font-semibold">
                                    Tool access
                                </h3>
                                <Text tone="muted">
                                    Inherit uses the root tools policy. An explicit allow
                                    or deny changes only this agent’s policy layer.
                                </Text>
                            </div>
                            <Input
                                className="lg:w-80"
                                disabled={disabled || busy}
                                onChange={(event) =>
                                    setToolFilter(event.currentTarget.value)
                                }
                                placeholder="Filter tools..."
                                value={toolFilter}
                            />
                        </div>

                        <div className="grid gap-3 xl:grid-cols-2 xl:gap-4">
                            {(["read", "standard", "elevated", "critical"] as const).map(
                                (risk) => {
                                    const tools = activeAgent.tools.filter((tool) => {
                                        const presentation = toolPresentation[tool.id];
                                        return (
                                            toolRisk[tool.id] === risk &&
                                            `${tool.id} ${presentation.label} ${presentation.description}`
                                                .toLowerCase()
                                                .includes(normalizedFilter)
                                        );
                                    });
                                    if (tools.length === 0) return null;
                                    return (
                                        <div
                                            className={cn(
                                                "overflow-hidden rounded-xl border",
                                                riskStyles[risk]
                                            )}
                                            key={risk}
                                        >
                                            <div className="border-b border-current/10 p-3 sm:px-4">
                                                <h4 className="text-primary-100 font-semibold">
                                                    {riskLabels[risk]}
                                                </h4>
                                            </div>
                                            <ul className="divide-primary-800 bg-primary-950/30 divide-y">
                                                {tools.map((tool) => {
                                                    const presentation =
                                                        toolPresentation[tool.id];
                                                    return (
                                                        <li
                                                            className="grid gap-3 p-3 sm:px-4 lg:grid-cols-[minmax(0,1fr)_14rem] lg:items-center"
                                                            key={tool.id}
                                                        >
                                                            <div className="min-w-0">
                                                                <div className="flex flex-wrap items-center gap-2">
                                                                    <span className="text-primary-100 font-medium">
                                                                        {
                                                                            presentation.label
                                                                        }
                                                                    </span>
                                                                    {!tool.editable && (
                                                                        <Badge variant="warning">
                                                                            Locked
                                                                        </Badge>
                                                                    )}
                                                                </div>
                                                                <Text
                                                                    className="mt-1"
                                                                    tone="muted"
                                                                >
                                                                    {
                                                                        presentation.description
                                                                    }
                                                                    {!tool.editable &&
                                                                        " This policy uses an explicit or ambiguous rule that this narrow control will not rewrite."}
                                                                </Text>
                                                            </div>
                                                            <Select
                                                                ariaLabel={`${presentation.label} override for ${agentLabel(activeAgent)}`}
                                                                disabled={
                                                                    disabled ||
                                                                    busy ||
                                                                    !tool.editable
                                                                }
                                                                onChange={(override) =>
                                                                    void onSave({
                                                                        agentId:
                                                                            activeAgent.id,
                                                                        override,
                                                                        section:
                                                                            "agent-tool-access",
                                                                        toolId: tool.id,
                                                                    })
                                                                }
                                                                options={overrideOptions}
                                                                value={tool.override}
                                                            />
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        </div>
                                    );
                                }
                            )}
                        </div>
                    </div>
                )}
            </ExpandableCard>
        </section>
    );
}
