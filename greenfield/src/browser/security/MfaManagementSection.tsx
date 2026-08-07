import { useForm } from "@tanstack/react-form";
import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, RefreshCw, ShieldOff, Smartphone, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import * as v from "valibot";

import {
    disableMfaInputSchema,
    factorLabelSchema,
    totpStepUpInputSchema,
    type AccountSecuritySummary,
    type TotpEnrollment,
} from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { OneTimeSecretPanel, SecuritySection } from "./SecurityUi.tsx";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

const optionalFactorLabelFormSchema = v.strictObject({
    label: v.union([v.literal(""), factorLabelSchema]),
});

interface MfaManagementSectionProps {
    readonly summary: AccountSecuritySummary;
}

/**
 * Manages possession factors and one-time recovery material in component-local state.
 * @returns The MFA management section.
 */
export function MfaManagementSection({ summary }: MfaManagementSectionProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const webAuthn = useDashboardWebAuthnClient();
    const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
    const [totpEnrollment, setTotpEnrollment] = useState<TotpEnrollment>();

    async function refreshAfter(operation: () => Promise<unknown>): Promise<boolean> {
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        return result.status === "success";
    }

    const totpLabelForm = useForm({
        defaultValues: { label: "" },
        onSubmit: async ({ formApi, value }) => {
            const result = await action.run(() =>
                client.mutation(
                    "accountSecurity.beginTotpEnrollment",
                    value.label.length === 0 ? {} : { label: value.label }
                )
            );
            if (result.status === "success") {
                setTotpEnrollment(result.value.enrollment);
                formApi.setFieldValue("label", "");
            }
        },
        validators: { onSubmit: optionalFactorLabelFormSchema },
    });
    const webAuthnLabelForm = useForm({
        defaultValues: { label: "" },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await refreshAfter(async () => {
                const challenge = await client.mutation(
                    "accountSecurity.beginWebAuthnEnrollment",
                    {}
                );
                const response = await webAuthn.register(challenge.options);
                const result = await client.mutation(
                    "accountSecurity.confirmWebAuthnEnrollment",
                    value.label.length === 0
                        ? { response }
                        : { label: value.label, response }
                );
                if (result.enabledNow) setRecoveryCodes(result.recoveryCodes);
            });
            if (succeeded) formApi.setFieldValue("label", "");
        },
        validators: { onSubmit: optionalFactorLabelFormSchema },
    });
    const totpConfirmationForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            const enrollment = totpEnrollment;
            if (enrollment === undefined) return;
            const succeeded = await refreshAfter(async () => {
                const result = await client.mutation(
                    "accountSecurity.confirmTotpEnrollment",
                    { code: value.code, factorId: enrollment.factorId }
                );
                if (result.enabledNow) setRecoveryCodes(result.recoveryCodes);
            });
            if (succeeded) {
                formApi.setFieldValue("code", "");
                setTotpEnrollment(undefined);
            }
        },
        validators: { onSubmit: totpStepUpInputSchema },
    });
    const disableMfaForm = useForm({
        defaultValues: { password: "" },
        onSubmit: async ({ formApi, value }) => {
            const succeeded = await refreshAfter(() =>
                client.mutation("accountSecurity.disableMfa", value)
            );
            if (succeeded) {
                formApi.setFieldValue("password", "");
                setRecoveryCodes(undefined);
                setTotpEnrollment(undefined);
            }
        },
        validators: { onSubmit: disableMfaInputSchema },
    });

    async function rotateRecoveryCodes() {
        await refreshAfter(async () => {
            const result = await client.mutation(
                "accountSecurity.rotateRecoveryCodes",
                {}
            );
            setRecoveryCodes(result.recoveryCodes);
        });
    }

    async function removeTotp(factorId: string) {
        await refreshAfter(() =>
            client.mutation("accountSecurity.removeTotpFactor", { factorId })
        );
    }

    async function removeWebAuthn(credentialId: string) {
        await refreshAfter(() =>
            client.mutation("accountSecurity.removeWebAuthnCredential", {
                credentialId,
            })
        );
    }

    const factorCount =
        summary.mfa.totpFactors.length + summary.mfa.webAuthnCredentials.length;
    const factorCapacityReached = factorCount >= 4;
    return (
        <SecuritySection
            description="Enroll and remove possession factors. Enrollment secrets and recovery codes are never query-cached."
            id="mfa-management-heading"
            title="Multi-factor authentication"
        >
            <Alert className="mb-4" message={action.error} />
            <p className="text-primary-300 text-sm">
                Status: {summary.mfa.enabled ? "Enabled" : "Disabled"} · {factorCount} of
                4 possession factors
            </p>

            {recoveryCodes !== undefined && (
                <OneTimeSecretPanel
                    id="recovery-code-secret"
                    onDismiss={() => setRecoveryCodes(undefined)}
                    title="New recovery codes"
                >
                    <ul className="space-y-1">
                        {recoveryCodes.map((code) => (
                            <li key={code}>{code}</li>
                        ))}
                    </ul>
                </OneTimeSecretPanel>
            )}

            <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <div>
                    <Heading level={3}>Authenticator apps</Heading>
                    <ul className="mt-3 space-y-3">
                        {summary.mfa.totpFactors.map((factor) => (
                            <li
                                className="border-primary-700 rounded-lg border p-3 text-sm"
                                key={factor.id}
                            >
                                <p className="text-primary-100 font-medium">
                                    {factor.label}
                                </p>
                                <p className="text-primary-400 mt-1">
                                    Confirmed{" "}
                                    {formatDashboardDateTime(factor.confirmedAtMs)}
                                </p>
                                <Button
                                    busy={action.busy}
                                    busyLabel="Removing…"
                                    className="mt-3"
                                    onClick={() => void removeTotp(factor.id)}
                                    size="sm"
                                    variant="danger"
                                >
                                    <Icon icon={Trash2} size="sm" tone="inherit" />
                                    Remove
                                </Button>
                            </li>
                        ))}
                    </ul>
                    <Form
                        className="mt-4"
                        onSubmit={() => void totpLabelForm.handleSubmit()}
                    >
                        <totpLabelForm.Field name="label">
                            {(field) => (
                                <FormField
                                    disabled={factorCapacityReached || action.busy}
                                    error={firstFormFieldError(field.state.meta.errors)}
                                    label="Authenticator label"
                                >
                                    <Input
                                        className="mt-2"
                                        name={field.name}
                                        onBlur={field.handleBlur}
                                        onChange={(event) =>
                                            field.handleChange(event.currentTarget.value)
                                        }
                                        placeholder="Phone authenticator"
                                        value={field.state.value}
                                    />
                                </FormField>
                            )}
                        </totpLabelForm.Field>
                        <totpLabelForm.Subscribe
                            selector={(state) =>
                                [state.canSubmit, state.isSubmitting] as const
                            }
                        >
                            {([canSubmit, isSubmitting]) => (
                                <Button
                                    busy={action.busy || isSubmitting}
                                    busyLabel="Starting enrollment…"
                                    className="mt-3"
                                    disabled={factorCapacityReached || !canSubmit}
                                    type="submit"
                                >
                                    <Icon icon={Smartphone} size="sm" tone="inherit" />
                                    Begin authenticator enrollment
                                </Button>
                            )}
                        </totpLabelForm.Subscribe>
                    </Form>
                </div>

                <div>
                    <Heading level={3}>Security keys</Heading>
                    <ul className="mt-3 space-y-3">
                        {summary.mfa.webAuthnCredentials.map((credential) => (
                            <li
                                className="border-primary-700 rounded-lg border p-3 text-sm"
                                key={credential.id}
                            >
                                <p className="text-primary-100 font-medium">
                                    {credential.label}
                                </p>
                                <p className="text-primary-400 mt-1">
                                    Added{" "}
                                    {formatDashboardDateTime(credential.createdAtMs)} ·
                                    {credential.usable ? " usable" : " unavailable"}
                                </p>
                                <Button
                                    busy={action.busy}
                                    busyLabel="Removing…"
                                    className="mt-3"
                                    onClick={() => void removeWebAuthn(credential.id)}
                                    size="sm"
                                    variant="danger"
                                >
                                    <Icon icon={Trash2} size="sm" tone="inherit" />
                                    Remove
                                </Button>
                            </li>
                        ))}
                    </ul>
                    {summary.webAuthn.available ? (
                        <Form
                            className="mt-4"
                            onSubmit={() => void webAuthnLabelForm.handleSubmit()}
                        >
                            <webAuthnLabelForm.Field name="label">
                                {(field) => (
                                    <FormField
                                        disabled={factorCapacityReached || action.busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Security-key label"
                                    >
                                        <Input
                                            className="mt-2"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            placeholder="Primary security key"
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </webAuthnLabelForm.Field>
                            <webAuthnLabelForm.Subscribe
                                selector={(state) =>
                                    [state.canSubmit, state.isSubmitting] as const
                                }
                            >
                                {([canSubmit, isSubmitting]) => (
                                    <Button
                                        busy={action.busy || isSubmitting}
                                        busyLabel="Waiting for security key…"
                                        className="mt-3"
                                        disabled={factorCapacityReached || !canSubmit}
                                        type="submit"
                                    >
                                        <Icon
                                            icon={Fingerprint}
                                            size="sm"
                                            tone="inherit"
                                        />
                                        Enroll security key
                                    </Button>
                                )}
                            </webAuthnLabelForm.Subscribe>
                        </Form>
                    ) : (
                        <p className="text-primary-400 mt-3 text-sm">
                            WebAuthn is unavailable for this origin.
                        </p>
                    )}
                </div>
            </div>

            {totpEnrollment !== undefined && (
                <OneTimeSecretPanel
                    id="totp-enrollment-secret"
                    onDismiss={() => {
                        totpConfirmationForm.setFieldValue("code", "");
                        setTotpEnrollment(undefined);
                    }}
                    title="Authenticator enrollment secret"
                >
                    <div className="font-sans">
                        <div className="inline-flex rounded-lg bg-white p-2">
                            <QRCodeSVG
                                marginSize={4}
                                size={176}
                                title="Authenticator enrollment QR code"
                                value={totpEnrollment.otpauthUri}
                            />
                        </div>
                        <p className="mt-3 font-mono text-sm break-all">
                            {totpEnrollment.secret}
                        </p>
                        <p className="mt-2 font-mono text-xs break-all">
                            {totpEnrollment.otpauthUri}
                        </p>
                        <Form
                            className="mt-4"
                            onSubmit={() => void totpConfirmationForm.handleSubmit()}
                        >
                            <totpConfirmationForm.Field name="code">
                                {(field) => (
                                    <FormField
                                        disabled={action.busy}
                                        error={firstFormFieldError(
                                            field.state.meta.errors
                                        )}
                                        label="Confirmation code"
                                    >
                                        <Input
                                            autoComplete="one-time-code"
                                            className="mt-2"
                                            inputMode="numeric"
                                            name={field.name}
                                            onBlur={field.handleBlur}
                                            onChange={(event) =>
                                                field.handleChange(
                                                    event.currentTarget.value
                                                )
                                            }
                                            required
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </totpConfirmationForm.Field>
                            <totpConfirmationForm.Subscribe
                                selector={(state) =>
                                    [state.canSubmit, state.isSubmitting] as const
                                }
                            >
                                {([canSubmit, isSubmitting]) => (
                                    <Button
                                        busy={action.busy || isSubmitting}
                                        busyLabel="Confirming…"
                                        className="mt-3"
                                        disabled={!canSubmit}
                                        type="submit"
                                    >
                                        <Icon
                                            icon={Smartphone}
                                            size="sm"
                                            tone="inherit"
                                        />
                                        Confirm authenticator
                                    </Button>
                                )}
                            </totpConfirmationForm.Subscribe>
                        </Form>
                    </div>
                </OneTimeSecretPanel>
            )}

            {summary.mfa.enabled && (
                <div className="border-primary-700 mt-8 border-t pt-6">
                    <Button
                        busy={action.busy}
                        busyLabel="Rotating…"
                        onClick={() => void rotateRecoveryCodes()}
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Rotate recovery codes
                    </Button>
                    <Form
                        className="mt-6 max-w-md"
                        onSubmit={() => void disableMfaForm.handleSubmit()}
                    >
                        <disableMfaForm.Field name="password">
                            {(field) => (
                                <FormField
                                    disabled={action.busy}
                                    error={firstFormFieldError(field.state.meta.errors)}
                                    label="Current password to disable MFA"
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
                        </disableMfaForm.Field>
                        <disableMfaForm.Subscribe
                            selector={(state) =>
                                [state.canSubmit, state.isSubmitting] as const
                            }
                        >
                            {([canSubmit, isSubmitting]) => (
                                <Button
                                    busy={action.busy || isSubmitting}
                                    busyLabel="Disabling MFA…"
                                    className="mt-3"
                                    disabled={!canSubmit}
                                    type="submit"
                                    variant="danger"
                                >
                                    <Icon icon={ShieldOff} size="sm" tone="inherit" />
                                    Disable MFA
                                </Button>
                            )}
                        </disableMfaForm.Subscribe>
                    </Form>
                </div>
            )}
        </SecuritySection>
    );
}
