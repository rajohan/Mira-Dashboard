import { Check, Loader2, ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";

import type { AgentConfig } from "../../../hooks/useConfig";
import { cn } from "../../../utils/cn";
import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";
import { Switch } from "../../ui/Switch";
import { TOOL_CATALOG, TOOL_RISK_LABELS, type ToolRisk } from "./toolCatalog";

/** Describes agent access section props. */
interface AgentAccessSectionProps {
    agents: AgentConfig[];
    onSave: (agents: AgentConfig[]) => Promise<void>;
    saving: boolean;
}

/** Handles tool enabled. */
function toolEnabled(agent: AgentConfig, toolId: string): boolean {
    if (agent.tools?.deny?.includes(toolId)) {
        return false;
    }

    if (agent.tools?.allow && agent.tools.allow.length > 0) {
        return agent.tools.allow.includes(toolId);
    }

    return true;
}

/** Handles update tool. */
function updateTool(agent: AgentConfig, toolId: string, enabled: boolean): AgentConfig {
    const deny = new Set(agent.tools?.deny || []);
    const allow = agent.tools?.allow ? new Set(agent.tools.allow) : null;

    if (enabled) {
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
            allow: allow ? [...allow].sort() : agent.tools?.allow,
            deny: [...deny].sort(),
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
export function AgentAccessSection({ agents, onSave, saving }: AgentAccessSectionProps) {
    const [activeAgentId, setActiveAgentId] = useState(agents[0]?.id || "");
    const [toolFilter, setToolFilter] = useState("");
    const [draftAgents, setDraftAgents] = useState(() => agents);

    useEffect(() => {
        setDraftAgents(agents);
        setActiveAgentId((previous) =>
            agents.some((agent) => agent.id === previous) ? previous : agents[0]?.id || ""
        );
    }, [agents]);

    const activeAgent =
        draftAgents.find((agent) => agent.id === activeAgentId) || draftAgents[0];
    const filteredTools = TOOL_CATALOG.filter((tool) =>
        `${tool.label} ${tool.description} ${tool.id}`
            .toLowerCase()
            .includes(toolFilter.toLowerCase())
    );

    /** Handles update agent. */
    const updateAgent = (
        agentId: string,
        updater: (agent: AgentConfig) => AgentConfig
    ) => {
        setDraftAgents((previous) =>
            previous.map((agent) => (agent.id === agentId ? updater(agent) : agent))
        );
    };

    return (
        <ExpandableCard title="Agent access control" icon={ShieldCheck}>
            <div className="space-y-5">
                <div className="grid gap-2 sm:grid-cols-2 lg:flex lg:flex-wrap">
                    {draftAgents.map((agent) => {
                        const enabledCount = TOOL_CATALOG.filter((tool) =>
                            toolEnabled(agent, tool.id)
                        ).length;
                        return (
                            <button
                                key={agent.id}
                                type="button"
                                onClick={() => setActiveAgentId(agent.id)}
                                className={cn(
                                    "rounded-xl border px-3 py-3 text-left transition sm:px-4",
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
                                <h4 className="text-primary-100 text-lg font-semibold">
                                    Tool toggles
                                </h4>
                                <p className="text-primary-400 text-sm">
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
                                    return null;
                                }

                                const enabledCount = riskTools.filter((tool) =>
                                    toolEnabled(activeAgent, tool.id)
                                ).length;

                                return (
                                    <div
                                        key={risk}
                                        className={cn(
                                            "overflow-hidden rounded-xl border",
                                            riskStyles[risk]
                                        )}
                                    >
                                        <div className="flex items-center justify-between border-b border-current/10 px-3 py-3 sm:px-4">
                                            <div>
                                                <h5 className="text-primary-100 font-semibold">
                                                    {TOOL_RISK_LABELS[risk]}
                                                    <span className="bg-primary-800 ml-2 rounded-full px-2 py-0.5 text-sm text-current">
                                                        {enabledCount}/{riskTools.length}
                                                    </span>
                                                </h5>
                                            </div>
                                        </div>
                                        <div className="divide-primary-800 bg-primary-950/30 divide-y">
                                            {riskTools.map((tool) => {
                                                const Icon = tool.icon;
                                                return (
                                                    <div
                                                        key={tool.id}
                                                        className="flex flex-col gap-3 px-3 py-3 sm:flex-row sm:items-center sm:px-4"
                                                    >
                                                        <div className="bg-primary-800 text-accent-300 self-start rounded-lg p-2 sm:self-auto">
                                                            <Icon className="h-5 w-5" />
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <div className="text-primary-100 font-medium break-words">
                                                                {tool.label}
                                                            </div>
                                                            <div className="text-primary-500 text-sm break-words">
                                                                {tool.description}
                                                            </div>
                                                        </div>
                                                        <Switch
                                                            checked={toolEnabled(
                                                                activeAgent,
                                                                tool.id
                                                            )}
                                                            className="self-end sm:self-auto"
                                                            onChange={(checked) =>
                                                                updateAgent(
                                                                    activeAgent.id,
                                                                    (agent) =>
                                                                        updateTool(
                                                                            agent,
                                                                            tool.id,
                                                                            checked
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
                ) : null}

                <div className="flex justify-end">
                    <Button
                        className="w-full sm:w-auto"
                        variant="primary"
                        onClick={() => onSave(draftAgents)}
                        disabled={saving}
                    >
                        {saving ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Check className="h-4 w-4" />
                                Save access control
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </ExpandableCard>
    );
}
