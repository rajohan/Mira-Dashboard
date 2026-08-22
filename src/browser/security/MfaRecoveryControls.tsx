import { useForm } from "@tanstack/react-form";
import { ShieldOff } from "lucide-react";
import { useState } from "react";

import { disableMfaInputSchema } from "../../contracts/accountSecurity.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { progressiveFormValidators, touchedFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";

interface MfaRecoveryControlsProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly onDisable: (password: string) => Promise<boolean>;
}

/**
 * Keeps destructive MFA removal behind a password-confirmed modal.
 * @returns The disable action and its confirmation dialog.
 */
export function MfaRecoveryControls({ action, onDisable }: MfaRecoveryControlsProps) {
    const [open, setOpen] = useState(false);
    const disableForm = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            if (await onDisable(value.password)) {
                formApi.reset();
                setOpen(false);
            }
        },
        validators: progressiveFormValidators(disableMfaInputSchema),
    });

    function close(): void {
        if (action.busy) return;
        disableForm.reset();
        setOpen(false);
    }

    return (
        <>
            <Button disabled={action.busy} onClick={() => setOpen(true)} variant="danger">
                <Icon icon={ShieldOff} size="sm" tone="inherit" />
                Disable
            </Button>
            <Modal
                description="This removes every security key, authenticator app, and recovery code. Every browser will be signed out."
                dismissible={!action.busy}
                onClose={close}
                open={open}
                size="sm"
                title="Disable two-step login"
            >
                <Alert className="mb-4" message={action.error} />
                <Alert
                    className="mb-4"
                    message="You will need to enroll a new second factor before using protected actions again."
                    variant="warning"
                />
                <Form onSubmit={() => void disableForm.handleSubmit()}>
                    <disableForm.Field name="password">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={touchedFormFieldError(field.state.meta)}
                                label="Current password"
                            >
                                <Input
                                    autoComplete="current-password"
                                    className="mt-2"
                                    data-autofocus
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="Enter your current password"
                                    required
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </disableForm.Field>
                    <disableForm.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.isSubmitting] as const
                        }
                    >
                        {([canSubmit, isSubmitting]) => (
                            <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                <Button
                                    disabled={action.busy || isSubmitting}
                                    onClick={close}
                                    type="button"
                                    variant="secondary"
                                >
                                    Cancel
                                </Button>
                                <Button
                                    busy={action.busy || isSubmitting}
                                    busyLabel="Turning off MFA…"
                                    disabled={!canSubmit}
                                    type="submit"
                                    variant="danger"
                                >
                                    <Icon icon={ShieldOff} size="sm" tone="inherit" />
                                    Turn off MFA
                                </Button>
                            </div>
                        )}
                    </disableForm.Subscribe>
                </Form>
            </Modal>
        </>
    );
}
