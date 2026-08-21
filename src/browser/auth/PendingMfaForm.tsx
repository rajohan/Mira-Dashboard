import { useForm } from "@tanstack/react-form";
import { Fingerprint, LifeBuoy, ShieldCheck, Smartphone } from "lucide-react";
import { useState } from "react";

import {
    recoveryLoginInputSchema,
    totpLoginInputSchema,
    type AuthStatus,
} from "../../contracts/auth.ts";
import type { MultiFactorAuthenticationMethod } from "../../contracts/security.ts";
import { MfaMethodChooser } from "../security/MfaMethodChooser.tsx";
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
 * @returns A method chooser followed by the selected second-step control.
 */
export function PendingMfaForm({ status }: PendingMfaFormProps) {
    const { busy, clearError, client, error, run } = useAuthenticationAction();
    const webAuthn = useDashboardWebAuthnClient();
    const [selectedMethod, setSelectedMethod] =
        useState<MultiFactorAuthenticationMethod>();
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
    const activeMethod =
        selectedMethod !== undefined && methods.includes(selectedMethod)
            ? selectedMethod
            : undefined;
    const canChangeMethod = methods.length > 1;

    function chooseAnotherMethod() {
        totpForm.reset();
        recoveryForm.reset();
        clearError();
        setSelectedMethod(undefined);
    }

    async function submitWebAuthn() {
        await run(async () => {
            const challenge = await client.mutation("auth.beginWebAuthnLogin", {});
            const credential = await webAuthn.authenticate(challenge.options);
            await client.mutation("auth.loginWebAuthn", { response: credential });
        });
    }

    function chooseMethod(method: MultiFactorAuthenticationMethod) {
        clearError();
        setSelectedMethod(method);
        if (method === "webauthn") void submitWebAuthn();
    }

    return (
        <LoginPanel
            description={`Complete the second step for ${status.pendingLogin.username}.`}
            footer="A full Dashboard session is created after verification succeeds."
            icon={ShieldCheck}
            showStepHeading={false}
            title="Multi-factor authentication"
        >
            <Alert className="mb-5" message={error} />
            {activeMethod === undefined && (
                <MfaMethodChooser busy={busy} methods={methods} onChoose={chooseMethod} />
            )}
            {activeMethod === "totp" && (
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
            {activeMethod === "recovery" && (
                <Form onSubmit={() => void recoveryForm.handleSubmit()}>
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
                                    placeholder="Paste a recovery code"
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
                            >
                                <Icon icon={LifeBuoy} size="sm" tone="inherit" />
                                Use recovery code
                            </Button>
                        )}
                    </recoveryForm.Subscribe>
                </Form>
            )}
            {activeMethod === "webauthn" && (
                <div className="space-y-3">
                    <Button
                        busy={busy}
                        busyLabel="Waiting for security key…"
                        fullWidth
                        onClick={() => void submitWebAuthn()}
                    >
                        <Icon icon={Fingerprint} size="sm" tone="inherit" />
                        Use a security key
                    </Button>
                    {canChangeMethod && (
                        <Button
                            disabled={busy}
                            fullWidth
                            onClick={chooseAnotherMethod}
                            variant="ghost"
                        >
                            Choose another method
                        </Button>
                    )}
                </div>
            )}
            {activeMethod !== undefined &&
                activeMethod !== "webauthn" &&
                canChangeMethod && (
                    <Button
                        className="mt-3"
                        disabled={busy}
                        fullWidth
                        onClick={chooseAnotherMethod}
                        variant="ghost"
                    >
                        Choose another method
                    </Button>
                )}
        </LoginPanel>
    );
}
