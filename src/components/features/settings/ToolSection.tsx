import { Check, Loader2, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";

interface ToolSettings {
    profile?: string;
    webSearchEnabled: boolean;
    webSearchProvider: string;
    webFetchEnabled: boolean;
    execSecurity: string;
    execAsk: string;
    elevatedEnabled: boolean;
    agentToAgentEnabled: boolean;
    sessionsVisibility?: string;
}

interface ToolSectionProps extends ToolSettings {
    onSave: (values: ToolSettings) => Promise<void>;
    saving: boolean;
}

export function ToolSection({
    profile,
    webSearchEnabled,
    webSearchProvider,
    webFetchEnabled,
    execSecurity,
    execAsk,
    elevatedEnabled,
    agentToAgentEnabled,
    sessionsVisibility,
    onSave,
    saving,
}: ToolSectionProps) {
    const [draft, setDraft] = useState<ToolSettings>({
        profile,
        webSearchEnabled,
        webSearchProvider,
        webFetchEnabled,
        execSecurity,
        execAsk,
        elevatedEnabled,
        agentToAgentEnabled,
        sessionsVisibility,
    });

    useEffect(() => {
        setDraft({
            profile,
            webSearchEnabled,
            webSearchProvider,
            webFetchEnabled,
            execSecurity,
            execAsk,
            elevatedEnabled,
            agentToAgentEnabled,
            sessionsVisibility,
        });
    }, [
        profile,
        webSearchEnabled,
        webSearchProvider,
        webFetchEnabled,
        execSecurity,
        execAsk,
        elevatedEnabled,
        agentToAgentEnabled,
        sessionsVisibility,
    ]);

    return (
        <ExpandableCard title="Tools" icon={Wrench}>
            <div className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-3">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Tool profile
                        </label>
                        <Input
                            value={draft.profile || ""}
                            onChange={(event) =>
                                setDraft((previous) => ({
                                    ...previous,
                                    profile: event.target.value,
                                }))
                            }
                            placeholder="full"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Exec security
                        </label>
                        <Select
                            value={draft.execSecurity}
                            onChange={(value) =>
                                setDraft((previous) => ({
                                    ...previous,
                                    execSecurity: value,
                                }))
                            }
                            options={[
                                { value: "deny", label: "Deny" },
                                { value: "allowlist", label: "Allowlist" },
                                { value: "full", label: "Full" },
                            ]}
                            width="w-full"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Exec approval
                        </label>
                        <Select
                            value={draft.execAsk}
                            onChange={(value) =>
                                setDraft((previous) => ({ ...previous, execAsk: value }))
                            }
                            options={[
                                { value: "off", label: "Off" },
                                { value: "on-miss", label: "On miss" },
                                { value: "always", label: "Always" },
                            ]}
                            width="w-full"
                        />
                    </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                    <Switch
                        checked={draft.webSearchEnabled}
                        onChange={(checked) =>
                            setDraft((previous) => ({
                                ...previous,
                                webSearchEnabled: checked,
                            }))
                        }
                        label="Web search"
                        description="Allow web_search with the configured provider"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                    <Switch
                        checked={draft.webFetchEnabled}
                        onChange={(checked) =>
                            setDraft((previous) => ({
                                ...previous,
                                webFetchEnabled: checked,
                            }))
                        }
                        label="Web fetch"
                        description="Allow fetching and extracting URLs"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                    <Switch
                        checked={draft.elevatedEnabled}
                        onChange={(checked) =>
                            setDraft((previous) => ({
                                ...previous,
                                elevatedEnabled: checked,
                            }))
                        }
                        label="Elevated tools"
                        description="Allow privileged/elevated command surfaces"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                    <Switch
                        checked={draft.agentToAgentEnabled}
                        onChange={(checked) =>
                            setDraft((previous) => ({
                                ...previous,
                                agentToAgentEnabled: checked,
                            }))
                        }
                        label="Agent-to-agent"
                        description="Allow agents to communicate with other sessions"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Web search provider
                        </label>
                        <Input
                            value={draft.webSearchProvider}
                            onChange={(event) =>
                                setDraft((previous) => ({
                                    ...previous,
                                    webSearchProvider: event.target.value,
                                }))
                            }
                            placeholder="brave"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Sessions visibility
                        </label>
                        <Input
                            value={draft.sessionsVisibility || ""}
                            onChange={(event) =>
                                setDraft((previous) => ({
                                    ...previous,
                                    sessionsVisibility: event.target.value,
                                }))
                            }
                            placeholder="all"
                        />
                    </div>
                </div>

                <div className="flex justify-end">
                    <Button
                        variant="primary"
                        onClick={() => onSave(draft)}
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
                                Save tool settings
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </ExpandableCard>
    );
}

export type { ToolSettings };
