import { useForm } from "@tanstack/react-form";
import { Check, Clock, Loader2 } from "lucide-react";

import { Button } from "../../ui/Button";
import { ExpandableCard } from "../../ui/ExpandableCard";
import { Input } from "../../ui/Input";

interface SessionSectionProps {
    idleMinutes: number;
    onSave: (idleMinutes: number) => Promise<void>;
    saving: boolean;
}

export function SessionSection({ idleMinutes, onSave, saving }: SessionSectionProps) {
    const form = useForm({
        defaultValues: { idleMinutes },
        onSubmit: async ({ value }) => {
            await onSave(value.idleMinutes);
        },
    });

    return (
        <ExpandableCard title="Session" icon={Clock}>
            <form
                onSubmit={(e) => {
                    e.preventDefault();
                    form.handleSubmit();
                }}
                className="space-y-4"
            >
                <div>
                    <label className="mb-1.5 block text-sm font-medium text-primary-300">
                        Idle Timeout (minutes)
                    </label>
                    <form.Field name="idleMinutes">
                        {(field) => (
                            <Input
                                type="number"
                                value={field.state.value}
                                onChange={(e) =>
                                    field.handleChange(Number(e.target.value))
                                }
                                min={0}
                                max={1440}
                                className="w-full sm:w-32"
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
