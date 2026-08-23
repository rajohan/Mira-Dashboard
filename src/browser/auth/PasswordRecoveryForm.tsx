import { useForm } from "@tanstack/react-form";
import { KeyRound, Mail } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import {
    passwordResetInputSchema,
    passwordResetRequestInputSchema,
} from "../../contracts/auth.ts";
import { classifyDashboardBrowserFailure } from "../api/trpcError.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { progressiveFormValidators, touchedFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoginPanel } from "./LoginPanel.tsx";
import { useAuthenticationAction } from "./useAuthenticationAction.ts";

interface PasswordRecoveryFormProps {
    readonly onBack: () => void;
    readonly token?: string;
}

function passwordResetFailureMessage(error: unknown): string | undefined {
    return classifyDashboardBrowserFailure(error) === "unauthorized"
        ? "Password reset link is invalid or expired."
        : undefined;
}

/**
 * Requests a generic recovery email or consumes the token delivered by it.
 * @returns The recovery request or password replacement form.
 */
export function PasswordRecoveryForm({ onBack, token }: PasswordRecoveryFormProps) {
    const { busy, client, error, run } = useAuthenticationAction();
    const [complete, setComplete] = useState(false);
    const requestForm = useForm({
        defaultValues: { username: "" },
        onSubmit: async ({ value }) => {
            const succeeded = await run(() =>
                client.mutation("auth.requestPasswordReset", value)
            );
            if (succeeded) setComplete(true);
        },
        validators: progressiveFormValidators(passwordResetRequestInputSchema),
    });
    const resetForm = useForm({
        defaultValues: { password: "", token: token ?? "" },
        onSubmit: async ({ value }) => {
            const succeeded = await run(
                () =>
                    client.mutation("auth.resetPassword", {
                        password: value.password,
                        token: value.token,
                    }),
                { state: "anonymous" },
                passwordResetFailureMessage
            );
            if (succeeded) setComplete(true);
        },
        validators: progressiveFormValidators(passwordResetInputSchema),
    });
    const isReset = token !== undefined;
    const isResetTokenValid =
        token === undefined ||
        v.safeParse(passwordResetInputSchema.entries.token, token).success;
    const message = isReset
        ? "Your password has been changed."
        : "If that account exists, a reset link has been sent to its email address.";
    let content;
    if (complete) {
        content = <Alert message={message} variant="success" />;
    } else if (isReset && !isResetTokenValid) {
        content = <Alert message="Password reset link is invalid or expired." />;
    } else if (isReset) {
        content = (
            <Form onSubmit={() => void resetForm.handleSubmit()}>
                <resetForm.Field name="password">
                    {(field) => (
                        <FormField
                            disabled={busy}
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
                                required
                                type="password"
                                value={field.state.value}
                            />
                        </FormField>
                    )}
                </resetForm.Field>
                <Button busy={busy} className="mt-5" fullWidth type="submit">
                    <Icon icon={KeyRound} size="sm" tone="inherit" />
                    Change password
                </Button>
            </Form>
        );
    } else {
        content = (
            <Form onSubmit={() => void requestForm.handleSubmit()}>
                <requestForm.Field name="username">
                    {(field) => (
                        <FormField
                            disabled={busy}
                            error={touchedFormFieldError(field.state.meta)}
                            label="Username"
                        >
                            <Input
                                autoCapitalize="none"
                                autoComplete="username"
                                className="mt-2"
                                name={field.name}
                                onBlur={field.handleBlur}
                                onChange={(event) =>
                                    field.handleChange(event.currentTarget.value)
                                }
                                required
                                spellCheck={false}
                                value={field.state.value}
                            />
                        </FormField>
                    )}
                </requestForm.Field>
                <Button busy={busy} className="mt-5" fullWidth type="submit">
                    <Icon icon={Mail} size="sm" tone="inherit" />
                    Send reset link
                </Button>
            </Form>
        );
    }

    return (
        <LoginPanel
            description={
                isReset
                    ? "Choose a new dashboard password"
                    : "Request a short-lived reset link"
            }
            footer="Reset links expire after 15 minutes and can only be used once."
            icon={isReset ? KeyRound : Mail}
            title="Reset password"
        >
            <Alert className="mb-5" message={error} />
            {content}
            <Button
                className="mt-3"
                fullWidth
                onClick={onBack}
                type="button"
                variant="ghost"
            >
                Back to sign in
            </Button>
        </LoginPanel>
    );
}
