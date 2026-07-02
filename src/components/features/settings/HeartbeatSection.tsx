import { useForm } from "@tanstack/react-form";
import { Check, Heart, Loader2 } from "lucide-react";

import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";

/** Provides props for heartbeat section. */
interface HeartbeatSectionProperties {
    every: number;
    target: string;
    onSave: (every: number, target: string) => Promise<void>;
    saving: boolean;
}

/** Renders the heartbeat section UI. */
export function HeartbeatSection({
    every,
    target,
    onSave,
    saving,
}: HeartbeatSectionProperties) {
    const form = useForm({
        defaultValues: { every, target },
        onSubmit: async ({ value }) => {
            await onSave(value.every, value.target);
        },
    });

    return (
        <ExpandableCard title="Heartbeat" icon={Heart}>
            <form
                onSubmit={(event_) => {
                    event_.preventDefault();
                    form.handleSubmit();
                }}
                className="space-y-4"
            >
                <form.Field name="every">
                    {(field) => (
                        <Input
                            label="Interval (seconds)"
                            type="number"
                            value={field.state.value}
                            onChange={(event_) =>
                                field.handleChange(Number(event_.target.value))
                            }
                            min={60}
                            max={3600}
                            className="w-full sm:w-32"
                        />
                    )}
                </form.Field>
                <form.Field name="target">
                    {(field) => (
                        <Input
                            label="Target Channel"
                            type="text"
                            value={field.state.value}
                            onChange={(event_) => field.handleChange(event_.target.value)}
                            placeholder="Channel ID or name"
                            className="w-full sm:w-64"
                        />
                    )}
                </form.Field>
                <div className="flex justify-end">
                    <Button
                        type="submit"
                        variant="primary"
                        className="w-full sm:w-auto"
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
                                Save
                            </>
                        )}
                    </Button>
                </div>
            </form>
        </ExpandableCard>
    );
}
