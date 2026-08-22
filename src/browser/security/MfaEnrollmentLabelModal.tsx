import { useForm } from "@tanstack/react-form";
import type { LucideIcon } from "lucide-react";

import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { progressiveFormValidators, touchedFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";
import { optionalFactorLabelFormSchema } from "./mfaFormSchemas.ts";

interface MfaEnrollmentLabelModalProps {
    readonly busy: boolean;
    readonly busyLabel: string;
    readonly description: string;
    readonly icon: LucideIcon;
    readonly inputLabel: string;
    readonly onCancel: () => void;
    readonly onCompleted: () => void;
    readonly onSubmit: (label: string) => Promise<boolean>;
    readonly placeholder: string;
    readonly submitLabel: string;
    readonly title: string;
}

/** @returns A focused label step before an MFA enrollment begins. */
export function MfaEnrollmentLabelModal({
    busy,
    busyLabel,
    description,
    icon,
    inputLabel,
    onCancel,
    onCompleted,
    onSubmit,
    placeholder,
    submitLabel,
    title,
}: MfaEnrollmentLabelModalProps) {
    const form = useForm({
        defaultValues: { label: "" },
        onSubmit: async ({ value }) => {
            if (await onSubmit(value.label)) onCompleted();
        },
        validators: progressiveFormValidators(optionalFactorLabelFormSchema),
    });

    return (
        <Modal
            description={description}
            dismissible={!busy}
            onClose={onCancel}
            open
            size="sm"
            title={title}
        >
            <Form onSubmit={() => void form.handleSubmit()}>
                <form.Field name="label">
                    {(field) => (
                        <FormField
                            disabled={busy}
                            error={touchedFormFieldError(field.state.meta)}
                            label={inputLabel}
                        >
                            <Input
                                className="mt-2"
                                data-autofocus
                                name={field.name}
                                onBlur={field.handleBlur}
                                onChange={(event) =>
                                    field.handleChange(event.currentTarget.value)
                                }
                                placeholder={placeholder}
                                value={field.state.value}
                            />
                        </FormField>
                    )}
                </form.Field>
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                            <Button
                                disabled={busy || isSubmitting}
                                onClick={onCancel}
                                type="button"
                                variant="secondary"
                            >
                                Cancel
                            </Button>
                            <Button
                                busy={busy || isSubmitting}
                                busyLabel={busyLabel}
                                disabled={!canSubmit}
                                type="submit"
                            >
                                <Icon icon={icon} size="sm" tone="inherit" />
                                {submitLabel}
                            </Button>
                        </div>
                    )}
                </form.Subscribe>
            </Form>
        </Modal>
    );
}
