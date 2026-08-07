import { Bot } from "lucide-react";

import { Checkbox } from "../ui/Checkbox.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Input } from "../ui/Input.tsx";
import type { TaskEditorFormApi } from "./useTaskEditorController.ts";

interface TaskAutomationFieldsProps {
    readonly busy: boolean;
    readonly form: TaskEditorFormApi;
}

/** @returns Optional OpenClaw automation relationship fields. */
export function TaskAutomationFields({ busy, form }: TaskAutomationFieldsProps) {
    return (
        <form.Subscribe selector={(state) => state.values.automationEnabled}>
            {(automationEnabled) => (
                <ExpandableCard
                    className="mt-5"
                    defaultOpen={automationEnabled}
                    description="Link this task to an existing OpenClaw cron job."
                    icon={Bot}
                    title="Automation"
                >
                    <form.Field name="automationEnabled">
                        {(field) => (
                            <Checkbox
                                checked={field.state.value}
                                disabled={busy}
                                label="Attach automation"
                                onChange={field.handleChange}
                            />
                        )}
                    </form.Field>
                    {automationEnabled && (
                        <div className="mt-4 grid gap-4 sm:grid-cols-2">
                            <form.Field name="automationCronJobId">
                                {(field) => (
                                    <FormField
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Cron job id"
                                    >
                                        <Input
                                            className="mt-2"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            required
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                            <form.Field name="automationScheduleSummary">
                                {(field) => (
                                    <FormField
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Schedule summary"
                                    >
                                        <Input
                                            className="mt-2"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            placeholder="Every weekday at 08:00"
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                            <form.Field name="automationModel">
                                {(field) => (
                                    <FormField
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Model"
                                    >
                                        <Input
                                            className="mt-2"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                            <form.Field name="automationThinking">
                                {(field) => (
                                    <FormField
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Thinking"
                                    >
                                        <Input
                                            className="mt-2"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                            <form.Field name="automationSessionTarget">
                                {(field) => (
                                    <FormField
                                        className="sm:col-span-2"
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Session target"
                                    >
                                        <Input
                                            className="mt-2"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                            <form.Field name="automationRecurring">
                                {(field) => (
                                    <Checkbox
                                        checked={field.state.value}
                                        className="sm:col-span-2"
                                        disabled={busy}
                                        description="Keep the recurring relationship visible on the board."
                                        label="Recurring automation"
                                        onChange={field.handleChange}
                                    />
                                )}
                            </form.Field>
                        </div>
                    )}
                </ExpandableCard>
            )}
        </form.Subscribe>
    );
}
