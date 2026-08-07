import { useForm } from "@tanstack/react-form";
import { Fingerprint, LifeBuoy, ShieldCheck, Smartphone } from "lucide-react";

import {
    recoveryLoginInputSchema,
    totpLoginInputSchema,
    type AuthStatus,
} from "../../contracts/auth.ts";
import { useDashboardWebAuthnClient } from "../security/webauthn/webauthnContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoginPanel } from "./LoginPanel.tsx";
import { useAuthenticationAction } from "./useAuthenticationAction.ts";

interface PendingMfaFormProps {
    readonly status: Extract<AuthStatus, { state: "pending-mfa" }>;
}

/**
 * Completes pending authentication with one available MFA method.
 * @returns TOTP, recovery-code, and WebAuthn second-step controls.
 */
export function PendingMfaForm({ status }: PendingMfaFormProps) {
    const { busy, client, error, run } = useAuthenticationAction();
    const webAuthn = useDashboardWebAuthnClient();
    const totpForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.loginTotp", value);
                formApi.setFieldValue("code", "");
            });
        },
        validators: { onSubmit: totpLoginInputSchema },
    });
    const recoveryForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await run(async () => {
                await client.mutation("auth.loginRecovery", value);
                formApi.setFieldValue("code", "");
            });
        },
        validators: { onSubmit: recoveryLoginInputSchema },
    });
    const methods = status.pendingLogin.methods;
    const hasTotp = methods.includes("totp");
    const hasRecovery = methods.includes("recovery");
    const hasWebAuthn = methods.includes("webauthn");

    async function submitWebAuthn() {
        await run(async () => {
            const challenge = await client.mutation("auth.beginWebAuthnLogin", {});
            const credential = await webAuthn.authenticate(challenge.options);
            await client.mutation("auth.loginWebAuthn", { response: credential });
        });
    }

    return (
        <LoginPanel
            description={`Complete the second step for ${status.pendingLogin.username}.`}
            icon={ShieldCheck}
            title="Multi-factor authentication"
        >
            <Alert className="mb-5" message={error} />
            {hasTotp && (
                <Form onSubmit={() => void totpForm.handleSubmit()}>
                    <totpForm.Field name="code">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Authenticator code"
                            >
                                <Input
                                    autoComplete="one-time-code"
                                    className="mt-2"
                                    inputMode="numeric"
                                    name="totp"
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
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
                                busy={busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-5"
                                disabled={!canSubmit}
                                fullWidth
                                type="submit"
                            >
                                <Icon icon={Smartphone} size="sm" tone="inherit" />
                                Verify code
                            </Button>
                        )}
                    </totpForm.Subscribe>
                </Form>
            )}
            {hasRecovery && (
                <Form
                    className={
                        hasTotp ? "border-primary-700 mt-6 border-t pt-6" : undefined
                    }
                    onSubmit={() => void recoveryForm.handleSubmit()}
                >
                    <recoveryForm.Field name="code">
                        {(field) => (
                            <FormField
                                disabled={busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Recovery code"
                            >
                                <Input
                                    autoComplete="off"
                                    className="mt-2"
                                    name="recoveryCode"
                                    onBlur={field.handleBlur}
                                    onChange={(event) =>
                                        field.handleChange(event.currentTarget.value)
                                    }
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
                                busy={busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-5"
                                disabled={!canSubmit}
                                fullWidth
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
            {hasWebAuthn && (
                <Button
                    busy={busy}
                    busyLabel="Waiting for security key…"
                    className="mt-6"
                    fullWidth
                    onClick={() => void submitWebAuthn()}
                    variant="secondary"
                >
                    <Icon icon={Fingerprint} size="sm" tone="inherit" />
                    Use a security key
                </Button>
            )}
        </LoginPanel>
    );
}
