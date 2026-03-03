import { MessageSquare } from "lucide-react";

import { ExpandableCard, ReadOnlyField } from "../../ui/ExpandableCard";

interface ChannelSectionProps {
    discordEnabled: boolean;
    discordBotId: string;
}

export function ChannelSection({ discordEnabled, discordBotId }: ChannelSectionProps) {
    return (
        <ExpandableCard title="Channels" icon={MessageSquare}>
            <div className="space-y-2">
                <div className="flex items-center justify-between py-2">
                    <span className="text-sm text-slate-400">Discord</span>
                    <span className={discordEnabled ? "text-green-400" : "text-slate-500"}>
                        {discordEnabled ? "Enabled" : "Disabled"}
                    </span>
                </div>
                <ReadOnlyField label="Bot ID" value={discordBotId} />
            </div>
        </ExpandableCard>
    );
}