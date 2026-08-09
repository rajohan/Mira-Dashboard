import { useForm } from "@tanstack/react-form";
import { Save } from "lucide-react";
import { useId } from "react";
import * as v from "valibot";

import {
    type ScheduleConfiguration,
    type ScheduleKind,
    type ScheduleSummary,
} from "../../contracts/jobModel.ts";
import { canonicalScheduleTimeZones } from "../../contracts/scheduleTimeZones.ts";
import { Button } from "../ui/Button.tsx";
import { Combobox, type ComboboxOption } from "../ui/Combobox.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { TimePicker } from "../ui/TimePicker.tsx";
import {
    scheduleConfigurationFromEditor,
    scheduleEditorFormSchema,
    scheduleEditorValues,
} from "./scheduleEditorForm.ts";

const scheduleKindOptions: readonly SelectOption<ScheduleKind>[] = Object.freeze([
    { description: "Run after a fixed duration.", label: "Interval", value: "interval" },
    { description: "Run once per local day.", label: "Daily", value: "daily" },
    { description: "Use a five-field minute cron.", label: "Cron", value: "cron" },
]);

const timeZoneOptions = Object.freeze(
    canonicalScheduleTimeZones.map((timeZone) => ({ label: timeZone, value: timeZone }))
) satisfies readonly ComboboxOption<string>[];

interface ScheduleEditorProps {
    readonly busy: boolean;
    readonly onSave: (configuration: ScheduleConfiguration) => Promise<void>;
    readonly schedule: ScheduleSummary;
}

function scheduleConfigurationsMatch(
    left: ScheduleConfiguration,
    right: ScheduleConfiguration
): boolean {
    if (left.kind !== right.kind) return false;
    switch (left.kind) {
        case "cron": {
            return (
                right.kind === left.kind &&
                left.expression === right.expression &&
                left.timeZone === right.timeZone
            );
        }
        case "daily": {
            return (
                right.kind === left.kind &&
                left.timeOfDay === right.timeOfDay &&
                left.timeZone === right.timeZone
            );
        }
        case "interval": {
            return right.kind === left.kind && left.intervalMs === right.intervalMs;
        }
    }
}

/** @returns A contract-validated editor for one code-owned schedule cadence. */
export function ScheduleEditor({ busy, onSave, schedule }: ScheduleEditorProps) {
    const editorFormId = useId();
    const form = useForm({
        defaultValues: scheduleEditorValues(schedule),
        onSubmit: async ({ value }) => {
            const parsed = v.parse(scheduleEditorFormSchema, value);
            const configuration = scheduleConfigurationFromEditor(parsed);
            if (scheduleConfigurationsMatch(configuration, schedule.schedule)) return;
            await onSave(configuration);
        },
        validators: { onSubmit: scheduleEditorFormSchema },
    });

    async function submitEditor(): Promise<void> {
        try {
            await form.handleSubmit();
        } catch {
            // The owning mutation renders its classified failure.
        }
        setTimeout(() => {
            document
                .querySelector<HTMLElement>(`[id="${editorFormId}"]`)
                ?.querySelector<HTMLElement>("[data-invalid]:is(button, input)")
                ?.focus();
        }, 0);
    }

    return (
        <Form
            aria-label={`Edit ${schedule.name} schedule`}
            className="grid gap-4 sm:grid-cols-2 sm:items-start"
            id={editorFormId}
            onSubmit={submitEditor}
        >
            <form.Field name="kind">
                {(field) => (
                    <FormField
                        description={
                            field.state.value === "cron" ? (
                                <span
                                    aria-hidden="true"
                                    className="invisible select-none"
                                    data-cron-description-spacer=""
                                >
                                    Order: minute, hour, day, month, weekday.
                                </span>
                            ) : undefined
                        }
                        disabled={busy}
                        error={firstFormFieldError(field.state.meta.errors)}
                        label="Schedule type"
                    >
                        <Select
                            className="mt-2"
                            disabled={busy}
                            name={field.name}
                            onChange={field.handleChange}
                            options={scheduleKindOptions}
                            value={field.state.value}
                        />
                    </FormField>
                )}
            </form.Field>
            <form.Subscribe selector={(state) => state.values.kind}>
                {(kind) => (
                    <>
                        {kind === "interval" && (
                            <form.Field name="intervalSeconds">
                                {(field) => (
                                    <FormField
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Interval (seconds)"
                                    >
                                        <Input
                                            className="mt-2"
                                            inputMode="decimal"
                                            max="31536000"
                                            min="60"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            placeholder="Example: 300"
                                            required
                                            step="0.001"
                                            type="number"
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                        )}
                        {kind === "daily" && (
                            <form.Field name="timeOfDay">
                                {(field) => (
                                    <TimePicker
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Time of day (24-hour)"
                                        onChange={field.handleChange}
                                        value={field.state.value}
                                    />
                                )}
                            </form.Field>
                        )}
                        {kind === "cron" && (
                            <form.Field name="cronExpression">
                                {(field) => (
                                    <FormField
                                        description="Order: minute, hour, day, month, weekday."
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Cron expression"
                                    >
                                        <Input
                                            className="mt-2 font-mono"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            placeholder="Example: 0 6 * * 1-5"
                                            required
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                        )}
                        {kind !== "interval" && (
                            <form.Field name="timeZone">
                                {(field) => (
                                    <FormField
                                        description="Use UTC or a region such as Europe/Oslo."
                                        disabled={busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Time zone"
                                    >
                                        <Combobox
                                            ariaLabel="Time zone"
                                            className="mt-2"
                                            disabled={busy}
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={field.handleChange}
                                            options={timeZoneOptions}
                                            placeholder="Example: Europe/Oslo"
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </form.Field>
                        )}
                    </>
                )}
            </form.Subscribe>
            <form.Subscribe
                selector={(state) => [state.canSubmit, state.values] as const}
            >
                {([canSubmit, values]) => {
                    const parsed = v.safeParse(scheduleEditorFormSchema, values);
                    const unchanged =
                        parsed.success &&
                        scheduleConfigurationsMatch(
                            scheduleConfigurationFromEditor(parsed.output),
                            schedule.schedule
                        );
                    return (
                        <div className="flex justify-end sm:col-span-2">
                            <Button
                                busy={busy}
                                busyLabel="Saving…"
                                disabled={!canSubmit || unchanged}
                                type="submit"
                            >
                                <Icon icon={Save} size="sm" tone="inherit" />
                                Save schedule
                            </Button>
                        </div>
                    );
                }}
            </form.Subscribe>
        </Form>
    );
}
