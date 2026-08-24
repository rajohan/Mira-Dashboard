import { useForm } from "@tanstack/react-form";
import { UserRoundPlus } from "lucide-react";

import { firstUserBootstrapInputSchema } from "../../contracts/auth.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { progressiveFormValidators, touchedFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoginPanel } from "./LoginPanel.tsx";
import { useAuthenticationAction } from "./useAuthenticationAction.ts";

/**
 * Verifies the existing Gateway credential and creates the first operator.
 * @returns The one-time first-user setup form.
 */
export function BootstrapForm() {
    const { busy, client, error, run } = useAuthenticationAction();
    const form = useForm({
        defaultValues: {
            email: "",
            gatewayCredential: "",
            password: "",
            username: "",
        },
        onSubmit: async ({ value }) => {
            await run(async () => {
                await client.mutation("auth.bootstrap", value);
            });
        },
        validators: progressiveFormValidators(firstUserBootstrapInputSchema),
    });

    return (
        <LoginPanel
            description="Connect the Dashboard to OpenClaw and create the first account."
            footer="The Gateway credential is only needed during first-user setup."
            icon={UserRoundPlus}
            showStepHeading={false}
            title="Set up Mira Dashboard"
        >
            <Alert className="mb-5" message={error} />
            <Form onSubmit={() => void form.handleSubmit()}>
                <div className="space-y-4">
                    <form.Field name="username">
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
                                    placeholder="operator"
                                    required
                                    spellCheck={false}
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="email">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={touchedFormFieldError(field.state.meta)}
                                label="Account email"
                            >
                                <Input
                                    autoCapitalize="none"
                                    autoComplete="email"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="you@example.com"
                                    required
                                    spellCheck={false}
                                    type="email"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="password">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={touchedFormFieldError(field.state.meta)}
                                label="Dashboard password"
                            >
                                <Input
                                    autoComplete="new-password"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="Create a strong password"
                                    required
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </form.Field>
                    <form.Field name="gatewayCredential">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={touchedFormFieldError(field.state.meta)}
                                label="OpenClaw Gateway credential"
                            >
                                <Input
                                    autoComplete="off"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="Paste the Gateway credential"
                                    required
                                    spellCheck={false}
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
                            busyLabel="Creating account…"
                            className="mt-5"
                            disabled={!canSubmit}
                            fullWidth
                            type="submit"
                        >
                            <Icon icon={UserRoundPlus} size="sm" tone="inherit" />
                            Create account
                        </Button>
                    )}
                </form.Subscribe>
            </Form>
        </LoginPanel>
    );
}
