import { Check, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Switch } from "../../ui/Switch";

interface ChannelSummary {
    id: string;
    enabled: boolean;
    policy?: string;
    details?: string;
}

interface ChannelSectionProps {
    channels: ChannelSummary[];
    onSave: (channels: ChannelSummary[]) => Promise<void>;
    saving: boolean;
}

export function ChannelSection({ channels, onSave, saving }: ChannelSectionProps) {
    const [draftChannels, setDraftChannels] = useState(channels);

    useEffect(() => {
        setDraftChannels(channels);
    }, [channels]);

    const enabledCount = draftChannels.filter((channel) => channel.enabled).length;

    return (
        <ExpandableCard title="Channels" icon={MessageSquare}>
            <div className="space-y-4">
                <p className="text-primary-400 text-sm">
                    {enabledCount}/{draftChannels.length} configured channels enabled
                </p>

                {draftChannels.length === 0 ? (
                    <div className="border-primary-800 bg-primary-900/50 text-primary-400 rounded-lg border p-3 text-sm">
                        No channels configured in OpenClaw config.
                    </div>
                ) : (
                    <div className="grid gap-3 lg:grid-cols-2">
                        {draftChannels.map((channel) => (
                            <Switch
                                key={channel.id}
                                checked={channel.enabled}
                                onChange={(checked) =>
                                    setDraftChannels((previous) =>
                                        previous.map((item) =>
                                            item.id === channel.id
                                                ? { ...item, enabled: checked }
                                                : item
                                        )
                                    )
                                }
                                label={channel.id}
                                description={
                                    [channel.policy, channel.details]
                                        .filter(Boolean)
                                        .join(" · ") || "Configured channel"
                                }
                                className="border-primary-800 bg-primary-900/50 rounded-lg border p-3"
                            />
                        ))}
                    </div>
                )}

                <div className="flex justify-end">
                    <Button
                        className="w-full sm:w-auto"
                        variant="primary"
                        onClick={() => onSave(draftChannels)}
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
                                Save channels
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </ExpandableCard>
    );
}

export type { ChannelSummary };
