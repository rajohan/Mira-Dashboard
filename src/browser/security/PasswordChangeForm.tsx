import { useForm } from "@tanstack/react-form";
import { ShieldCheck } from "lucide-react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    authStatusQueryKey,
    publishAuthenticationStatusIfCurrent,
} from "../auth/authQueries.ts";
import {
    AuthenticatedMutationExpiredError,
    useAuthenticatedMutationBoundary,
} from "../auth/useAuthenticatedMutationBoundary.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { progressiveFormValidators, touchedFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";
import { passwordChangeFormSchema, passwordChangeInput } from "./passwordChangeForm.ts";

interface PasswordChangeFormProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly complete: (
        operation: () => Promise<unknown>,
        successMessage: string
    ) => Promise<boolean>;
    readonly onClose: () => void;
    readonly open: boolean;
}

/**
 * Rotates the Dashboard password from a transient, validated modal form.
 * @returns The password-change dialog.
 */
export function PasswordChangeForm({
    action,
    complete,
    onClose,
    open,
}: PasswordChangeFormProps) {
    const client = useDashboardTrpcClient();
    const mutationBoundary = useAuthenticatedMutationBoundary();
    const queryClient = mutationBoundary.queryClient;
    const form = useForm({
        defaultValues: {
            confirmPassword: "",
            currentPassword: "",
            newPassword: "",
        },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await complete(async () => {
                const cachedStatus =
                    queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
                if (cachedStatus?.state !== "authenticated") {
                    throw new TypeError(
                        "Password change requires an authenticated cache owner"
                    );
                }
                const mutation = await mutationBoundary.run(async (signal, isActive) => ({
                    isActive,
                    result: await client.mutation(
                        "auth.changePassword",
                        passwordChangeInput(value),
                        { signal }
                    ),
                }));
                const published = await publishAuthenticationStatusIfCurrent(
                    queryClient,
                    {
                        ...cachedStatus,
                        session: mutation.result.session,
                    },
                    mutation.isActive
                );
                if (!published) throw new AuthenticatedMutationExpiredError();
            }, "Password changed. Your other browsers were signed out.");
            if (succeeded) {
                formApi.reset();
                onClose();
            }
        },
        validators: progressiveFormValidators(passwordChangeFormSchema),
    });

    function close(): void {
        if (action.busy) return;
        form.reset();
        onClose();
    }

    return (
        <Modal
            description="Changing it signs every other browser out. Forgotten passwords use a short-lived email link."
            dismissible={!action.busy}
            onClose={close}
            open={open}
            size="sm"
            title="Change Dashboard password"
        >
            <Alert className="mb-4" message={action.error} />
            <Form className="space-y-4" onSubmit={() => void form.handleSubmit()}>
                <form.Field name="currentPassword">
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
                </form.Field>
                <form.Field name="newPassword">
                    {(field) => (
                        <FormField
                            disabled={action.busy}
                            description="Use 8–256 characters."
                            error={touchedFormFieldError(field.state.meta)}
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
                                placeholder="Use at least 8 characters"
                                required
                                type="password"
                                value={field.state.value}
                            />
                        </FormField>
                    )}
                </form.Field>
                <form.Field name="confirmPassword">
                    {(field) => (
                        <FormField
                            disabled={action.busy}
                            error={touchedFormFieldError(field.state.meta)}
                            label="Confirm new password"
                        >
                            <Input
                                autoComplete="new-password"
                                className="mt-2"
                                name={field.name}
                                onBlur={field.handleBlur}
                                onChange={(event) =>
                                    field.handleChange(event.currentTarget.value)
                                }
                                placeholder="Re-enter your new password"
                                required
                                type="password"
                                value={field.state.value}
                            />
                        </FormField>
                    )}
                </form.Field>
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <div className="flex flex-col-reverse gap-2 pt-1 sm:flex-row sm:justify-end">
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
                                busyLabel="Changing password…"
                                disabled={!canSubmit}
                                type="submit"
                            >
                                <Icon icon={ShieldCheck} size="sm" tone="inherit" />
                                Change and sign out others
                            </Button>
                        </div>
                    )}
                </form.Subscribe>
            </Form>
        </Modal>
    );
}
