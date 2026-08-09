import { useForm } from "@tanstack/react-form";
import { Fingerprint, KeyRound, LifeBuoy, Smartphone } from "lucide-react";

import {
    passwordReauthenticationInputSchema,
    recoveryStepUpInputSchema,
    totpStepUpInputSchema,
} from "../../contracts/accountSecurity.ts";
import type { MultiFactorAuthenticationMethod } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface SecurityProofControlsProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly complete: (
        operation: () => Promise<unknown>,
        successMessage: string
    ) => Promise<void>;
    readonly methods: readonly MultiFactorAuthenticationMethod[];
}

/**
 * Renders the available password and MFA recent-verification controls.
 * @returns Contract-validated proof forms for every enrolled method.
 */
export function SecurityProofControls({
    action,
    complete,
    methods,
}: SecurityProofControlsProps) {
    const client = useDashboardTrpcClient();
    const webAuthn = useDashboardWebAuthnClient();
    const passwordProofForm = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("accountSecurity.reauthenticatePassword", value);
                formApi.setFieldValue("password", "");
            }, "Password confirmed.");
        },
        validators: { onSubmit: passwordReauthenticationInputSchema },
    });
    const totpForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("accountSecurity.stepUpTotp", value);
                formApi.setFieldValue("code", "");
            }, "Authenticator code accepted.");
        },
        validators: { onSubmit: totpStepUpInputSchema },
    });
    const recoveryForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("accountSecurity.stepUpRecovery", value);
                formApi.setFieldValue("code", "");
            }, "Recovery code accepted.");
        },
        validators: { onSubmit: recoveryStepUpInputSchema },
    });

    async function stepUpWebAuthn() {
        await complete(async () => {
            const challenge = await client.mutation(
                "accountSecurity.beginWebAuthnStepUp",
                {}
            );
            const response = await webAuthn.authenticate(challenge.options);
            await client.mutation("accountSecurity.stepUpWebAuthn", { response });
        }, "Security key confirmed.");
    }

    return (
        <div className="grid gap-6 lg:grid-cols-2">
            <Form onSubmit={() => void passwordProofForm.handleSubmit()}>
                <passwordProofForm.Field name="password">
                    {(field) => (
                        <FormField
                            disabled={action.busy}
                            error={firstFormFieldError(field.state.meta.errors)}
                            label="Password to confirm your identity"
                        >
                            <Input
                                autoComplete="current-password"
                                className="mt-2"
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
                </passwordProofForm.Field>
                <passwordProofForm.Subscribe
                    selector={(state) => [state.canSubmit, state.isSubmitting] as const}
                >
                    {([canSubmit, isSubmitting]) => (
                        <Button
                            busy={action.busy || isSubmitting}
                            busyLabel="Verifying…"
                            className="mt-3"
                            disabled={!canSubmit}
                            type="submit"
                        >
                            <Icon icon={KeyRound} size="sm" tone="inherit" />
                            Verify password
                        </Button>
                    )}
                </passwordProofForm.Subscribe>
            </Form>
            {methods.includes("totp") && (
                <Form onSubmit={() => void totpForm.handleSubmit()}>
                    <totpForm.Field name="code">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Authenticator code"
                            >
                                <Input
                                    autoComplete="one-time-code"
                                    className="mt-2"
                                    inputMode="numeric"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="123456"
                                    required
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </totpForm.Field>
                    <totpForm.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.isSubmitting] as const
                        }
                    >
                        {([canSubmit, isSubmitting]) => (
                            <Button
                                busy={action.busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-3"
                                disabled={!canSubmit}
                                type="submit"
                            >
                                <Icon icon={Smartphone} size="sm" tone="inherit" />
                                Verify authenticator
                            </Button>
                        )}
                    </totpForm.Subscribe>
                </Form>
            )}
            {methods.includes("recovery") && (
                <Form onSubmit={() => void recoveryForm.handleSubmit()}>
                    <recoveryForm.Field name="code">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Recovery code"
                            >
                                <Input
                                    autoComplete="off"
                                    className="mt-2"
                                    name={field.name}
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
                                    placeholder="00000000000000000000000000000000-11111111111111111111111111111111"
                                    required
                                    spellCheck={false}
                                    type="password"
                                    value={field.state.value}
                                />
                            </FormField>
                        )}
                    </recoveryForm.Field>
                    <recoveryForm.Subscribe
                        selector={(state) =>
                            [state.canSubmit, state.isSubmitting] as const
                        }
                    >
                        {([canSubmit, isSubmitting]) => (
                            <Button
                                busy={action.busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-3"
                                disabled={!canSubmit}
                                type="submit"
                                variant="secondary"
                            >
                                <Icon icon={LifeBuoy} size="sm" tone="inherit" />
                                Use recovery code
                            </Button>
                        )}
                    </recoveryForm.Subscribe>
                </Form>
            )}
            {methods.includes("webauthn") && (
                <div>
                    <p className="text-primary-300 text-sm">
                        Confirm your identity with one of your security keys.
                    </p>
                    <Button
                        busy={action.busy}
                        busyLabel="Waiting for security key…"
                        className="mt-3"
                        onClick={() => void stepUpWebAuthn()}
                        variant="secondary"
                    >
                        <Icon icon={Fingerprint} size="sm" tone="inherit" />
                        Verify security key
                    </Button>
                </div>
            )}
        </div>
    );
}
