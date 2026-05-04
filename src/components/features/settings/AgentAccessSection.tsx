import { Check, Loader2, ShieldCheck } from "lucide-react";
import { useState } from "react";

import type { AgentConfig } from "../../../hooks/useConfig";
import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";

interface AgentAccessSectionProps {
    agents: AgentConfig[];
    defaultSkills?: string[];
    onSave: (agents: AgentConfig[], defaultSkills?: string[]) => Promise<void>;
    saving: boolean;
}

function parseList(value: string): string[] | undefined {
    const items = value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);

    return items.length > 0 ? items : undefined;
}

function formatList(value: string[] | undefined): string {
    return (value || []).join(", ");
}

export function AgentAccessSection({
    agents,
    defaultSkills,
    onSave,
    saving,
}: AgentAccessSectionProps) {
    const [draftAgents, setDraftAgents] = useState(() => agents);
    const [draftDefaultSkills, setDraftDefaultSkills] = useState(() =>
        formatList(defaultSkills)
    );

    const updateAgent = (agentId: string, patch: Partial<AgentConfig>) => {
        setDraftAgents((previous) =>
            previous.map((agent) =>
                agent.id === agentId
                    ? {
                          ...agent,
                          ...patch,
                          tools: { ...agent.tools, ...patch.tools },
                      }
                    : agent
            )
        );
    };

    return (
        <ExpandableCard title="Agent access control" icon={ShieldCheck}>
            <div className="space-y-4">
                <p className="text-sm text-primary-400">
                    Configure skill allowlists and per-agent tool policy. Empty fields
                    inherit OpenClaw defaults; explicit empty arrays can still be handled
                    later in the raw config editor.
                </p>

                <div className="rounded-lg border border-primary-700 bg-primary-900/50 p-3">
                    <label className="mb-1.5 block text-sm font-medium text-primary-300">
                        Default skill allowlist
                    </label>
                    <Input
                        value={draftDefaultSkills}
                        onChange={(event) => setDraftDefaultSkills(event.target.value)}
                        placeholder="Leave empty for unrestricted skills"
                    />
                    <p className="mt-1 text-xs text-primary-500">
                        Comma-separated skill IDs inherited by agents without their own
                        list.
                    </p>
                </div>

                <div className="space-y-3">
                    {draftAgents.map((agent) => (
                        <div
                            key={agent.id}
                            className="rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                        >
                            <div className="mb-3 flex items-center justify-between">
                                <div>
                                    <h4 className="font-medium text-primary-100">
                                        {agent.name || agent.id}
                                    </h4>
                                    <p className="text-xs text-primary-500">
                                        {agent.default
                                            ? "Default agent"
                                            : "Configured agent"}
                                    </p>
                                </div>
                            </div>

                            <div className="grid gap-3 lg:grid-cols-3">
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-primary-400">
                                        Skills
                                    </label>
                                    <Input
                                        value={formatList(agent.skills)}
                                        onChange={(event) =>
                                            updateAgent(agent.id, {
                                                skills: parseList(event.target.value),
                                            })
                                        }
                                        placeholder="inherit"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-primary-400">
                                        Tools allow
                                    </label>
                                    <Input
                                        value={formatList(agent.tools?.allow)}
                                        onChange={(event) =>
                                            updateAgent(agent.id, {
                                                tools: {
                                                    allow: parseList(event.target.value),
                                                },
                                            })
                                        }
                                        placeholder="inherit"
                                    />
                                </div>
                                <div>
                                    <label className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-primary-400">
                                        Tools deny
                                    </label>
                                    <Input
                                        value={formatList(agent.tools?.deny)}
                                        onChange={(event) =>
                                            updateAgent(agent.id, {
                                                tools: {
                                                    deny: parseList(event.target.value),
                                                },
                                            })
                                        }
                                        placeholder="none"
                                    />
                                </div>
                            </div>
                        </div>
                    ))}
                </div>

                <div className="flex justify-end">
                    <Button
                        variant="primary"
                        onClick={() => onSave(draftAgents, parseList(draftDefaultSkills))}
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
