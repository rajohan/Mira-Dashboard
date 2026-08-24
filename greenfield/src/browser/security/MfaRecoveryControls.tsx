import { useForm } from "@tanstack/react-form";
import { RefreshCw, ShieldOff } from "lucide-react";

import { disableMfaInputSchema } from "../../contracts/accountSecurity.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";

interface MfaRecoveryControlsProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly onDisable: (password: string) => Promise<boolean>;
    readonly onRequestRecoveryCodeRotation: () => void;
}

/**
 * Renders recovery-code rotation and password-confirmed MFA disable controls.
 * @returns Consequential MFA maintenance controls.
 */
export function MfaRecoveryControls({
    action,
    onDisable,
    onRequestRecoveryCodeRotation,
}: MfaRecoveryControlsProps) {
    const disableForm = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            if (await onDisable(value.password)) {
                formApi.setFieldValue("password", "");
            }
        },
        validators: { onSubmit: disableMfaInputSchema },
    });

    return (
        <div className="border-primary-700 mt-8 border-t pt-6">
            <Button
                busy={action.busy}
                busyLabel="Rotating…"
                onClick={onRequestRecoveryCodeRotation}
                variant="secondary"
            >
                <Icon icon={RefreshCw} size="sm" tone="inherit" />
                Rotate recovery codes
            </Button>
            <Form
                className="mt-6 max-w-md"
                onSubmit={() => void disableForm.handleSubmit()}
            >
                <disableForm.Field name="password">
                    {(field) => (
                        <FormField
                            disabled={action.busy}
                            error={firstFormFieldError(field.state.meta.errors)}
                            label="Current password to disable MFA"
                        >
                            <Input
                                autoComplete="current-password"
                                className="mt-2"
                                name={field.name}
                                onBlur={field.handleBlur}
                                onChange={(event) =>
                                    field.handleChange(event.currentTarget.value)
                                }
                                required
                                type="password"
                                value={field.state.value}
                            />
                        </FormField>
                    )}
                </disableForm.Field>
                <disableForm.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={action.busy || isSubmitting}
                            busyLabel="Disabling MFA…"
                            className="mt-3"
                            disabled={!canSubmit}
                            type="submit"
                            variant="danger"
                        >
                            <Icon icon={ShieldOff} size="sm" tone="inherit" />
                            Disable MFA
                        </Button>
                    )}
                </disableForm.Subscribe>
            </Form>
        </div>
    );
}
