import { Check, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentConfig } from "../../../hooks/useConfig";
import { cn } from "../../../utils/cn";
import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";
import { Switch } from "../../ui/Switch";
import { TOOL_CATALOG, TOOL_RISK_LABELS, type ToolRisk } from "./toolCatalog";

/** Provides props for agent access section. */
interface AgentAccessSectionProperties {
    agents: AgentConfig[];
    onSave: (agents: AgentConfig[]) => Promise<void>;
    saving: boolean;
}

/** Performs tool enabled. */
function isToolEnabled(agent: AgentConfig, toolId: string): boolean {
    if (agent.tools?.deny?.includes(toolId)) {
        return false;
    }

    if (agent.tools?.allow && agent.tools.allow.length > 0) {
        return agent.tools.allow.includes(toolId);
    }

    return true;
}

/** Performs update tool. */
function updateTool(agent: AgentConfig, toolId: string, isEnabled: boolean): AgentConfig {
    const deny = new Set(agent.tools?.deny || []);
    const allow = agent.tools?.allow ? new Set(agent.tools.allow) : undefined;

    if (isEnabled) {
        deny.delete(toolId);
        allow?.add(toolId);
    } else if (allow) {
        allow.delete(toolId);
    } else {
        deny.add(toolId);
    }

    return {
        ...agent,
        tools: {
            ...agent.tools,
            allow: allow
                ? [...allow].toSorted((left, right) => left.localeCompare(right))
                : agent.tools?.allow,
            deny: [...deny].toSorted((left, right) => left.localeCompare(right)),
        },
    };
}

const riskStyles: Record<ToolRisk, string> = {
    read: "border-emerald-500/20 bg-emerald-500/5 text-emerald-300",
    standard: "border-blue-500/20 bg-blue-500/5 text-blue-300",
    elevated: "border-amber-500/20 bg-amber-500/5 text-amber-300",
    critical: "border-red-500/20 bg-red-500/5 text-red-300",
};

/** Renders the agent access section UI. */
export function AgentAccessSection({
    agents,
    onSave,
    saving,
}: AgentAccessSectionProperties) {
    const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || "");
    const [toolFilter, setToolFilter] = useState("");
    const [draftAgents, setDraftAgents] = useState(() => agents);

    useEffect(() => {
        setDraftAgents(agents);
        setActiveAgentId((wasPrevious) =>
            agents.some((agent) => agent.id === wasPrevious)
                ? wasPrevious
                : agents[0]?.id || ""
        );
    }, [agents]);

    const activeAgent =
        draftAgents.find((agent) => agent.id === activeAgentId) || draftAgents[0];
    const filteredTools = TOOL_CATALOG.filter((tool) =>
        `${tool.label} ${tool.description} ${tool.id}`
            .toLowerCase()
            .includes(toolFilter.toLowerCase())
    );

    /** Performs update agent. */
    const updateAgent = (
        agentId: string,
        updater: (agent: AgentConfig) => AgentConfig
    ) => {
        setDraftAgents((wasPrevious) =>
            wasPrevious.map((agent) => (agent.id === agentId ? updater(agent) : agent))
        );
    };

    return (
        <ExpandableCard title="Agent access control" icon={ShieldCheck}>
            <div className="space-y-5">
                <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
                    {draftAgents.map((agent) => {
                        const enabledCount = TOOL_CATALOG.filter((tool) =>
                            isToolEnabled(agent, tool.id)
                        ).length;
                        return (
                            <button
                                key={agent.id}
                                type="button"
                                onClick={() => setActiveAgentId(agent.id)}
                                aria-pressed={activeAgent?.id === agent.id}
                                className={cn(
                                    "rounded-xl border p-3 text-left transition sm:px-4",
                                    activeAgent?.id === agent.id
                                        ? "border-accent-500 bg-accent-500/10 text-accent-200"
                                        : "border-primary-700 bg-primary-900/40 text-primary-300 hover:border-primary-600"
                                )}
                            >
                                <div className="font-medium">
                                    {agent.name || agent.id}
                                </div>
                                <div className="mt-1 text-xs opacity-75">
                                    {enabledCount}/{TOOL_CATALOG.length} tools
                                </div>
                            </button>
                        );
                    })}
                </div>

                {activeAgent ? (
                    <div className="space-y-4">
                        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                            <div>
                                <h4 className="text-lg font-semibold text-primary-100">
                                    Tool toggles
                                </h4>
                                <p className="text-sm text-primary-400">
                                    Turning a tool off adds it to this agent’s deny list.
                                    Turning it back on clears that deny entry.
                                </p>
                            </div>
                            <Input
                                value={toolFilter}
                                onChange={(event) => setToolFilter(event.target.value)}
                                placeholder="Filter tools..."
                                className="lg:w-80"
                            />
                        </div>

                        <div className="grid gap-3 xl:grid-cols-2 xl:gap-4">
                            {(
                                ["read", "standard", "elevated", "critical"] as ToolRisk[]
                            ).map((risk) => {
                                const riskTools = filteredTools.filter(
                                    (tool) => tool.risk === risk
                                );
                                if (riskTools.length === 0) {
                                    return;
                                }

                                const enabledCount = riskTools.filter((tool) =>
                                    isToolEnabled(activeAgent, tool.id)
                                ).length;

                                return (
                                    <div
                                        key={risk}
                                        className={cn(
                                            "overflow-hidden rounded-xl border",
                                            riskStyles[risk]
                                        )}
                                    >
                                        <div className="flex items-center justify-between border-b border-current/10 p-3 sm:px-4">
                                            <div>
                                                <h5 className="font-semibold text-primary-100">
                                                    {TOOL_RISK_LABELS[risk]}
                                                    <span className="ml-2 rounded-full bg-primary-800 px-2 py-0.5 text-sm text-current">
                                                        {enabledCount}/{riskTools.length}
                                                    </span>
                                                </h5>
                                            </div>
                                        </div>
                                        <div className="divide-y divide-primary-800 bg-primary-950/30">
                                            {riskTools.map((tool) => {
                                                const Icon = tool.icon;
                                                return (
                                                    <div
                                                        key={tool.id}
                                                        className="flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:px-4"
                                                    >
                                                        <div className="self-start rounded-lg bg-primary-800 p-2 text-accent-300 sm:self-auto">
                                                            <Icon className="size-5" />
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="font-medium wrap-break-word text-primary-100">
                                                                {tool.label}
                                                            </div>
                                                            <div className="text-sm wrap-break-word text-primary-500">
                                                                {tool.description}
                                                            </div>
                                                        </div>
                                                        <Switch
                                                            isChecked={isToolEnabled(
                                                                activeAgent,
                                                                tool.id
                                                            )}
                                                            className="self-end sm:self-auto"
                                                            onChange={(isChecked) =>
                                                                updateAgent(
                                                                    activeAgent.id,
                                                                    (agent) =>
                                                                        updateTool(
                                                                            agent,
                                                                            tool.id,
                                                                            isChecked
                                                                        )
                                                                )
                                                            }
                                                        />
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </div>
                ) : undefined}

                <div className="flex justify-end">
                    <Button
                        className="w-full sm:w-auto"
                        variant="primary"
                        onClick={() => onSave(draftAgents)}
                        disabled={saving}
                    >
                        {saving ? (
                            <>
                                <Loader2 className="size-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Check className="size-4" />
                                Save access control
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </ExpandableCard>
    );
}
