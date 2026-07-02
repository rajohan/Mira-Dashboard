import { Check, Loader2, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";

/** Represents tool settings. */
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

/** Provides props for tool section. */
interface ToolSectionProperties extends ToolSettings {
    onSave: (values: ToolSettings) => Promise<void>;
    saving: boolean;
}

/** Renders the tool section UI. */
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
}: ToolSectionProperties) {
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
                    <Input
                        label="Tool profile"
                        value={draft.profile || ""}
                        onChange={(event) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                profile: event.target.value,
                            }))
                        }
                        placeholder="full"
                    />
                    <div>
                        <div className="mb-1.5 block text-sm font-medium text-primary-300">
                            Exec security
                        </div>
                        <Select
                            value={draft.execSecurity}
                            onChange={(value) =>
                                setDraft((wasPrevious) => ({
                                    ...wasPrevious,
                                    execSecurity: value,
                                }))
                            }
                            options={[
                                { value: "deny", label: "Deny" },
                                { value: "allowlist", label: "Allowlist" },
                                { value: "full", label: "Full" },
                            ]}
                            ariaLabel="Exec security"
                            width="w-full"
                        />
                    </div>
                    <div>
                        <div className="mb-1.5 block text-sm font-medium text-primary-300">
                            Exec approval
                        </div>
                        <Select
                            value={draft.execAsk}
                            onChange={(value) =>
                                setDraft((wasPrevious) => ({
                                    ...wasPrevious,
                                    execAsk: value,
                                }))
                            }
                            options={[
                                { value: "off", label: "Off" },
                                { value: "on-miss", label: "On miss" },
                                { value: "always", label: "Always" },
                            ]}
                            ariaLabel="Exec approval"
                            width="w-full"
                        />
                    </div>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                    <Switch
                        isChecked={draft.webSearchEnabled}
                        onChange={(isChecked) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                webSearchEnabled: isChecked,
                            }))
                        }
                        label="Web search"
                        description="Allow web_search with the configured provider"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                    <Switch
                        isChecked={draft.webFetchEnabled}
                        onChange={(isChecked) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                webFetchEnabled: isChecked,
                            }))
                        }
                        label="Web fetch"
                        description="Allow fetching and extracting URLs"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                    <Switch
                        isChecked={draft.elevatedEnabled}
                        onChange={(isChecked) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                elevatedEnabled: isChecked,
                            }))
                        }
                        label="Elevated tools"
                        description="Allow privileged/elevated command surfaces"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                    <Switch
                        isChecked={draft.agentToAgentEnabled}
                        onChange={(isChecked) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                agentToAgentEnabled: isChecked,
                            }))
                        }
                        label="Agent-to-agent"
                        description="Allow agents to communicate with other sessions"
                        className="rounded-lg border border-primary-800 bg-primary-900/50 p-3"
                    />
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                    <Input
                        label="Web search provider"
                        value={draft.webSearchProvider}
                        onChange={(event) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                webSearchProvider: event.target.value,
                            }))
                        }
                        placeholder="brave"
                    />
                    <Input
                        label="Sessions visibility"
                        value={draft.sessionsVisibility || ""}
                        onChange={(event) =>
                            setDraft((wasPrevious) => ({
                                ...wasPrevious,
                                sessionsVisibility: event.target.value,
                            }))
                        }
                        placeholder="all"
                    />
                </div>

                <div className="flex justify-end">
                    <Button
                        className="w-full sm:w-auto"
                        variant="primary"
                        onClick={() => onSave(draft)}
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
