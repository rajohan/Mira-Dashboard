import { Check, Loader2, Wrench } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "../../ui/Button";
import { ExpandableCard, ReadOnlyField } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";

interface ModelSectionProps {
    defaultModel: string;
    fallbacks: string[];
    imageModel?: string;
    imageGenerationModel?: string;
    onSave: (values: { primary: string; fallbacks: string[] }) => Promise<void>;
    saving: boolean;
}

function parseList(value: string): string[] {
    return value
        .split(/[\n,]/)
        .map((item) => item.trim())
        .filter(Boolean);
}

export function ModelSection({
    defaultModel,
    fallbacks,
    imageModel,
    imageGenerationModel,
    onSave,
    saving,
}: ModelSectionProps) {
    const [primary, setPrimary] = useState(defaultModel);
    const [fallbackText, setFallbackText] = useState(fallbacks.join(", "));

    useEffect(() => {
        setPrimary(defaultModel);
        setFallbackText(fallbacks.join(", "));
    }, [defaultModel, fallbacks]);

    return (
        <ExpandableCard title="Model Configuration" icon={Wrench}>
            <div className="space-y-4">
                <div className="grid gap-4 lg:grid-cols-2">
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Default model
                        </label>
                        <Input
                            value={primary}
                            onChange={(event) => setPrimary(event.target.value)}
                            placeholder="codex"
                        />
                    </div>
                    <div>
                        <label className="mb-1.5 block text-sm font-medium text-primary-300">
                            Fallback models
                        </label>
                        <Input
                            value={fallbackText}
                            onChange={(event) => setFallbackText(event.target.value)}
                            placeholder="glm51, kimi"
                        />
                    </div>
                </div>

                <div className="rounded-lg border border-primary-800 bg-primary-900/50 px-3 py-2">
                    <ReadOnlyField label="Image model" value={imageModel || "Not set"} />
                    <ReadOnlyField
                        label="Image generation model"
                        value={imageGenerationModel || "Not set"}
                    />
                </div>

                <div className="flex justify-end">
                    <Button
                        variant="primary"
                        onClick={() =>
                            onSave({
                                primary: primary.trim(),
                                fallbacks: parseList(fallbackText),
                            })
                        }
                        disabled={saving || !primary.trim()}
                    >
                        {saving ? (
                            <>
                                <Loader2 className="h-4 w-4 animate-spin" />
                                Saving...
                            </>
                        ) : (
                            <>
                                <Check className="h-4 w-4" />
                                Save model settings
                            </>
                        )}
                    </Button>
                </div>
            </div>
        </ExpandableCard>
    );
}
