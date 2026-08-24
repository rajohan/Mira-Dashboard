import { useForm } from "@tanstack/react-form";
import { Fingerprint, KeyRound, LifeBuoy, Smartphone } from "lucide-react";
import { useState } from "react";

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
import { MfaMethodChooser } from "./MfaMethodChooser.tsx";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface SecurityProofControlsProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly complete: (
        operation: () => Promise<unknown>,
        successMessage: string
    ) => Promise<boolean>;
    readonly methods: readonly MultiFactorAuthenticationMethod[];
    readonly mode: "mfa" | "password";
    readonly onVerified: () => void;
}

/**
 * Renders the available password and MFA recent-verification controls.
 * @returns A password proof or a selected, contract-validated MFA proof.
 */
export function SecurityProofControls({
    action,
    complete,
    methods,
    mode,
    onVerified,
}: SecurityProofControlsProps) {
    const client = useDashboardTrpcClient();
    const webAuthn = useDashboardWebAuthnClient();
    const [selectedMethod, setSelectedMethod] =
        useState<MultiFactorAuthenticationMethod>();
    const passwordProofForm = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await complete(async () => {
                await client.mutation("accountSecurity.reauthenticatePassword", value);
            }, "Password confirmed.");
            if (succeeded) {
                formApi.reset();
                onVerified();
            }
        },
        validators: { onSubmit: passwordReauthenticationInputSchema },
    });
    const totpForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await complete(async () => {
                await client.mutation("accountSecurity.stepUpTotp", value);
            }, "Authenticator code accepted.");
            if (succeeded) {
                formApi.reset();
                onVerified();
            }
        },
        validators: { onSubmit: totpStepUpInputSchema },
    });
    const recoveryForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await complete(async () => {
                await client.mutation("accountSecurity.stepUpRecovery", value);
            }, "Recovery code accepted.");
            if (succeeded) {
                formApi.reset();
                onVerified();
            }
        },
        validators: { onSubmit: recoveryStepUpInputSchema },
    });

    async function stepUpWebAuthn() {
        const succeeded = await complete(async () => {
            const challenge = await client.mutation(
                "accountSecurity.beginWebAuthnStepUp",
                {}
            );
            const response = await webAuthn.authenticate(challenge.options);
            await client.mutation("accountSecurity.stepUpWebAuthn", { response });
        }, "Security key confirmed.");
        if (succeeded) onVerified();
    }

    const activeMethod =
        selectedMethod !== undefined && methods.includes(selectedMethod)
            ? selectedMethod
            : undefined;
    const canChangeMethod = methods.length > 1;

    function chooseAnotherMethod() {
        totpForm.reset();
        recoveryForm.reset();
        action.clearError();
        setSelectedMethod(undefined);
    }

    function chooseMethod(method: MultiFactorAuthenticationMethod) {
        action.clearError();
        setSelectedMethod(method);
        if (method === "webauthn") void stepUpWebAuthn();
    }

    return (
        <div className="space-y-4">
            {mode === "password" && (
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
                    </passwordProofForm.Field>
                    <passwordProofForm.Subscribe
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
                                fullWidth
                                type="submit"
                            >
                                <Icon icon={KeyRound} size="sm" tone="inherit" />
                                Verify password
                            </Button>
                        )}
                    </passwordProofForm.Subscribe>
                </Form>
            )}
            {mode === "mfa" && activeMethod === undefined && (
                <MfaMethodChooser
                    busy={action.busy}
                    methods={methods}
                    onChoose={chooseMethod}
                />
            )}
            {mode === "mfa" && activeMethod === "totp" && (
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
                                    data-autofocus
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
                                fullWidth
                                type="submit"
                            >
                                <Icon icon={Smartphone} size="sm" tone="inherit" />
                                Verify authenticator
                            </Button>
                        )}
                    </totpForm.Subscribe>
                </Form>
            )}
            {mode === "mfa" && activeMethod === "recovery" && (
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
                                    data-autofocus
                                    name={field.name}
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
                                busy={action.busy || isSubmitting}
                                busyLabel="Verifying…"
                                className="mt-3"
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
            {mode === "mfa" && activeMethod === "webauthn" && (
                <Button
                    busy={action.busy}
                    busyLabel="Waiting for security key…"
                    fullWidth
                    onClick={() => void stepUpWebAuthn()}
                >
                    <Icon icon={Fingerprint} size="sm" tone="inherit" />
                    Verify security key
                </Button>
            )}
            {mode === "mfa" && activeMethod !== undefined && canChangeMethod && (
                <Button
                    disabled={action.busy}
                    fullWidth
                    onClick={chooseAnotherMethod}
                    variant="ghost"
                >
                    Choose another method
                </Button>
            )}
        </div>
    );
}
