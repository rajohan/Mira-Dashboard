import { Wrench } from "lucide-react";

import { ExpandableCard } from "../../ui/ExpandableCard";

interface ToolSectionProps {
    webSearchEnabled: boolean;
    webSearchProvider: string;
    execEnabled: boolean;
    execMode: string;
}

export function ToolSection({
    webSearchEnabled,
    webSearchProvider,
    execEnabled,
    execMode,
}: ToolSectionProps) {
    return (
        <ExpandableCard title="Tools" icon={Wrench}>
            <div className="space-y-2">
                <div className="flex items-center justify-between py-2">
                    <span className="text-sm text-primary-400">Web Search</span>
                    <span
                        className={webSearchEnabled ? "text-green-400" : "text-primary-500"}
                    >
                        {webSearchEnabled
                            ? "Enabled (" + webSearchProvider + ")"
                            : "Disabled"}
                    </span>
                </div>
                <div className="flex items-center justify-between py-2">
                    <span className="text-sm text-primary-400">Exec</span>
                    <span className={execEnabled ? "text-green-400" : "text-primary-500"}>
                        {execEnabled ? "Enabled (" + execMode + ")" : "Disabled"}
                    </span>
                </div>
            </div>
        </ExpandableCard>
    );
}
