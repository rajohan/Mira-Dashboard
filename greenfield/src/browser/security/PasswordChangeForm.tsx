import { useForm } from "@tanstack/react-form";
import { ShieldCheck } from "lucide-react";

import { passwordChangeInputSchema } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";

interface PasswordChangeFormProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly complete: (
        operation: () => Promise<unknown>,
        successMessage: string
    ) => Promise<void>;
}

/**
 * Rotates the Dashboard password and clears both proof fields after success.
 * @returns The password-change form.
 */
export function PasswordChangeForm({ action, complete }: PasswordChangeFormProps) {
    const client = useDashboardTrpcClient();
    const form = useForm({
        defaultValues: { currentPassword: "", newPassword: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("auth.changePassword", value);
                formApi.setFieldValue("currentPassword", "");
                formApi.setFieldValue("newPassword", "");
            }, "Password changed and other sessions revoked.");
        },
        validators: { onSubmit: passwordChangeInputSchema },
    });

    return (
        <Form
            className="border-primary-700 mt-8 border-t pt-6"
            onSubmit={() => void form.handleSubmit()}
        >
            <Heading level={3}>Change password</Heading>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <form.Field name="currentPassword">
                    {(field) => (
                        <FormField
                            disabled={action.busy}
                            error={firstFormFieldError(field.state.meta.errors)}
                            label="Current password"
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
                </form.Field>
                <form.Field name="newPassword">
                    {(field) => (
                        <FormField
                            disabled={action.busy}
                            error={firstFormFieldError(field.state.meta.errors)}
                            label="New password"
                        >
                            <Input
                                autoComplete="new-password"
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
                </form.Field>
            </div>
            <form.Subscribe
                selector={(state) => [state.canSubmit, state.isSubmitting] as const}
            >
                {([canSubmit, isSubmitting]) => (
                    <Button
                        busy={action.busy || isSubmitting}
                        busyLabel="Changing password…"
                        className="mt-3"
                        disabled={!canSubmit}
                        type="submit"
                    >
                        <Icon icon={ShieldCheck} size="sm" tone="inherit" />
                        Change password
                    </Button>
                )}
            </form.Subscribe>
        </Form>
    );
}
