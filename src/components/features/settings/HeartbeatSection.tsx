import { useForm } from "@tanstack/react-form";
import { Check, Heart, Loader2 } from "lucide-react";

import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";

interface HeartbeatSectionProps {
    every: number;
    target: string;
    onSave: (every: number, target: string) => Promise<void>;
    saving: boolean;
}

export function HeartbeatSection({
    every,
    target,
    onSave,
    saving,
}: HeartbeatSectionProps) {
    const form = useForm({
        defaultValues: { every, target },
        onSubmit: async ({ value }) => {
            await onSave(value.every, value.target);
        },
    });

    return (
        <ExpandableCard title="Heartbeat" icon={Heart}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    form.handleSubmit();
                }}
                className="space-y-4"
            >
                <div>
                    <label className="text-primary-300 mb-1.5 block text-sm font-medium">
                        Interval (seconds)
                    </label>
                    <form.Field name="every">
                        {(field) => (
                            <Input
                                type="number"
                                value={field.state.value}
                                onChange={(e) =>
                                    field.handleChange(Number(e.target.value))
                                }
                                min={60}
                                max={3600}
                                className="w-full sm:w-32"
                            />
                        )}
                    </form.Field>
                </div>
                <div>
                    <label className="text-primary-300 mb-1.5 block text-sm font-medium">
                        Target Channel
                    </label>
                    <form.Field name="target">
                        {(field) => (
                            <Input
                                type="text"
                                value={field.state.value}
                                onChange={(e) => field.handleChange(e.target.value)}
                                placeholder="Channel ID or name"
                                className="w-full sm:w-64"
                            />
                        )}
                    </form.Field>
                </div>
                <div className="flex justify-end">
                    <Button
                        type="submit"
                        variant="primary"
                        className="w-full sm:w-auto"
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
                                Save
                            </>
                        )}
                    </Button>
                </div>
            </form>
        </ExpandableCard>
    );
}
