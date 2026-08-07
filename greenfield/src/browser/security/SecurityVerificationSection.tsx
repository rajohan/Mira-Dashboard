import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, KeyRound, LifeBuoy, ShieldCheck, Smartphone } from "lucide-react";
import { useState } from "react";

import {
    passwordReauthenticationInputSchema,
    recoveryStepUpInputSchema,
    totpStepUpInputSchema,
    type AccountSecuritySummary,
} from "../../contracts/accountSecurity.ts";
import { passwordChangeInputSchema } from "../../contracts/auth.ts";
import type { MultiFactorAuthenticationMethod } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface SecurityVerificationSectionProps {
    readonly summary: AccountSecuritySummary;
}

/**
 * Renders recent-auth proofs and password rotation without retaining proofs in a cache.
 * @returns The verification management section.
 */
export function SecurityVerificationSection({
    summary,
}: SecurityVerificationSectionProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const webAuthn = useDashboardWebAuthnClient();
    const [notice, setNotice] = useState<string>();

    async function complete(
        operation: () => Promise<unknown>,
        successMessage: string
    ): Promise<void> {
        setNotice(undefined);
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        if (result.status === "success") setNotice(successMessage);
    }

    const passwordProofForm = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("accountSecurity.reauthenticatePassword", value);
                formApi.setFieldValue("password", "");
            }, "Recent password verification refreshed.");
        },
        validators: { onSubmit: passwordReauthenticationInputSchema },
    });
    const totpForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("accountSecurity.stepUpTotp", value);
                formApi.setFieldValue("code", "");
            }, "Recent MFA verification refreshed.");
        },
        validators: { onSubmit: totpStepUpInputSchema },
    });
    const recoveryForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            await complete(async () => {
                await client.mutation("accountSecurity.stepUpRecovery", value);
                formApi.setFieldValue("code", "");
            }, "Recovery proof accepted and recent MFA refreshed.");
        },
        validators: { onSubmit: recoveryStepUpInputSchema },
    });
    const passwordChangeForm = useForm({
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

    async function stepUpWebAuthn() {
        await complete(async () => {
            const challenge = await client.mutation(
                "accountSecurity.beginWebAuthnStepUp",
                {}
            );
            const response = await webAuthn.authenticate(challenge.options);
            await client.mutation("accountSecurity.stepUpWebAuthn", { response });
        }, "Security-key verification refreshed recent MFA.");
    }

    const methods: readonly MultiFactorAuthenticationMethod[] = summary.mfa.methods;
    return (
        <SecuritySection
            description="Refresh recent proof before sensitive changes and rotate the Dashboard password."
            id="security-verification-heading"
            title="Verification and password"
        >
            <Alert className="mb-4" message={action.error} />
            <Alert className="mb-4" message={notice} variant="success" />
            <dl className="mb-6 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-primary-400">Recent password</dt>
                    <dd className="text-primary-100 font-medium">
                        {summary.recentAuth.password.recent ? "Valid" : "Required"}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">Recent MFA</dt>
                    <dd className="text-primary-100 font-medium">
                        {summary.recentAuth.mfa.recent ? "Valid" : "Required"}
                    </dd>
                </div>
            </dl>
            <div className="grid gap-6 lg:grid-cols-2">
                <Form onSubmit={() => void passwordProofForm.handleSubmit()}>
                    <passwordProofForm.Field name="password">
                        {(field) => (
                            <FormField
                                disabled={action.busy}
                                error={firstFormFieldError(field.state.meta.errors)}
                                label="Password proof"
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
                                    label="Authenticator proof"
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
                                    label="Recovery proof"
                                >
                                    <Input
                                        autoComplete="off"
                                        className="mt-2"
                                        name={field.name}
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
                            Verify with one enrolled roaming security key.
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
            <Form
                className="border-primary-700 mt-8 border-t pt-6"
                onSubmit={() => void passwordChangeForm.handleSubmit()}
            >
                <Heading level={3}>Change password</Heading>
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                    <passwordChangeForm.Field name="currentPassword">
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
                    </passwordChangeForm.Field>
                    <passwordChangeForm.Field name="newPassword">
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
                    </passwordChangeForm.Field>
                </div>
                <passwordChangeForm.Subscribe
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
                </passwordChangeForm.Subscribe>
            </Form>
        </SecuritySection>
    );
}
