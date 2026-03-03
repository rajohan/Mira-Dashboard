import { Wrench } from "lucide-react";

import { ExpandableCard, ReadOnlyField } from "../../ui/ExpandableCard";

interface ModelSectionProps {
    defaultModel: string;
    fallbacks: string;
    contextWindow: number;
    temperature: number;
}

export function ModelSection({ defaultModel, fallbacks, contextWindow, temperature }: ModelSectionProps) {
    return (
        <ExpandableCard title="Model Configuration" icon={Wrench} defaultExpanded>
            <div className="space-y-2">
                <ReadOnlyField label="Default Model" value={defaultModel} />
                <ReadOnlyField label="Fallback Models" value={fallbacks} />
                <ReadOnlyField label="Context Window" value={contextWindow.toLocaleString() + " tokens"} />
                <ReadOnlyField label="Temperature" value={temperature} />
            </div>
        </ExpandableCard>
    );
}