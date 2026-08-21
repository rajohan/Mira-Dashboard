import { Card } from "../ui/Card.tsx";
import { Checkbox } from "../ui/Checkbox.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Input } from "../ui/Input.tsx";
import { Text } from "../ui/Text.tsx";
import type { TaskEditorFormApi } from "./useTaskEditorController.ts";

interface TaskAutomationFieldsProps {
    readonly busy: boolean;
    readonly form: TaskEditorFormApi;
}

/** @returns Optional OpenClaw automation relationship fields. */
export function TaskAutomationFields({ busy, form }: TaskAutomationFieldsProps) {
    return (
        <form.Subscribe selector={(state) => state.values.automationEnabled}>
            {(automationEnabled) => {
                const controls = (
                    <>
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
                            <div className="grid gap-3 sm:grid-cols-2">
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
                                                placeholder="morning-report"
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
                                                placeholder="openai/gpt-5.6"
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
                                                placeholder="high"
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
                                                placeholder="agent:main:main"
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
                    </>
                );

                return (
                    <Card className="bg-primary-900/30 mt-4 space-y-3 rounded-lg p-3 shadow-none">
                        <div>
                            <Heading className="text-primary-200 text-sm" level={3}>
                                Recurring automation (optional)
                            </Heading>
                            <Text className="mt-1" size="sm" tone="muted">
                                Link the task to an OpenClaw cron job so cards and details
                                can show live run state.
                            </Text>
                        </div>
                        {controls}
                    </Card>
                );
            }}
        </form.Subscribe>
    );
}
