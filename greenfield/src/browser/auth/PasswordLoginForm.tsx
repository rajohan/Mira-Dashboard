import { useForm } from "@tanstack/react-form";
import { KeyRound } from "lucide-react";

import { passwordLoginInputSchema } from "../../contracts/auth.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoginPanel } from "./LoginPanel.tsx";
import { useAuthenticationAction } from "./useAuthenticationAction.ts";

/**
 * Starts operator authentication with username and password.
 * @returns The primary sign-in form.
 */
export function PasswordLoginForm() {
    const { busy, client, error, run } = useAuthenticationAction();
    const form = useForm({
        defaultValues: { password: "", username: "" },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.login", value);
                formApi.setFieldValue("password", "");
            });
        },
        validators: { onSubmit: passwordLoginInputSchema },
    });

    return (
        <LoginPanel
            description="Use your Dashboard operator account."
            icon={KeyRound}
            title="Sign in"
        >
            <Alert className="mb-5" message={error} />
            <Form onSubmit={() => void form.handleSubmit()}>
                <div className="space-y-4">
                    <form.Field name="username">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
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
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Password"
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
                </div>
                <form.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={busy || isSubmitting}
                            busyLabel="Signing in…"
                            className="mt-5"
                            disabled={!canSubmit}
                            fullWidth
                            type="submit"
                        >
                            <Icon icon={KeyRound} size="sm" tone="inherit" />
                            Continue
                        </Button>
                    )}
                </form.Subscribe>
            </Form>
        </LoginPanel>
    );
}
