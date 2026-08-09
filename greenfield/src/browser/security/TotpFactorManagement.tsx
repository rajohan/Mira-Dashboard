import { useForm } from "@tanstack/react-form";
import { Smartphone, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";

import {
    totpStepUpInputSchema,
    type AccountSecuritySummary,
    type TotpEnrollment,
} from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Button } from "../ui/Button.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { MfaEnrollmentLabelModal } from "./MfaEnrollmentLabelModal.tsx";
import { OneTimeSecretPanel } from "./SecurityUi.tsx";

interface TotpFactorManagementProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly enrollment: TotpEnrollment | undefined;
    readonly factorCapacityReached: boolean;
    readonly factors: AccountSecuritySummary["mfa"]["totpFactors"];
    readonly onEnrollmentChange: (enrollment: TotpEnrollment | undefined) => void;
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
    readonly onRemove: (factor: Readonly<{ id: string; label: string }>) => void;
    readonly refreshAfter: (operation: () => Promise<unknown>) => Promise<boolean>;
}

/**
 * Manages authenticator-app factors and the ephemeral TOTP enrollment secret.
 * @returns Authenticator inventory and enrollment controls.
 */
export function TotpFactorManagement({
    action,
    enrollment,
    factorCapacityReached,
    factors,
    onEnrollmentChange,
    onRecoveryCodes,
    onRemove,
    refreshAfter,
}: TotpFactorManagementProps) {
    const client = useDashboardTrpcClient();
    const [labelModalOpen, setLabelModalOpen] = useState(false);
    const confirmationForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            if (enrollment === undefined) return;
            const succeeded = await refreshAfter(async () => {
                const result = await client.mutation(
                    "accountSecurity.confirmTotpEnrollment",
                    { code: value.code, factorId: enrollment.factorId }
                );
                if (result.enabledNow) onRecoveryCodes(result.recoveryCodes);
            });
            if (succeeded) {
                formApi.setFieldValue("code", "");
                onEnrollmentChange(undefined);
            }
        },
        validators: { onSubmit: totpStepUpInputSchema },
    });

    function dismissEnrollment() {
        confirmationForm.setFieldValue("code", "");
        onEnrollmentChange(undefined);
    }

    async function beginEnrollment(label: string): Promise<boolean> {
        const result = await action.run(() =>
            client.mutation(
                "accountSecurity.beginTotpEnrollment",
                label.length === 0 ? {} : { label }
            )
        );
        if (result.status !== "success") return false;
        onEnrollmentChange(result.value.enrollment);
        return true;
    }

    return (
        <div>
            <Heading level={3}>Authenticator apps</Heading>
            <ul className="mt-3 space-y-3">
                {factors.map((factor) => (
                    <li
                        className="border-primary-700 rounded-lg border p-3 text-sm"
                        key={factor.id}
                    >
                        <p className="text-primary-100 font-medium">{factor.label}</p>
                        <p className="text-primary-400 mt-1">
                            Confirmed {formatDashboardDateTime(factor.confirmedAtMs)}
                        </p>
                        <Button
                            aria-label={`Remove authenticator ${factor.label}`}
                            busy={action.busy}
                            busyLabel="Removing…"
                            className="mt-3"
                            onClick={() => onRemove(factor)}
                            size="sm"
                            variant="danger"
                        >
                            <Icon icon={Trash2} size="sm" tone="inherit" />
                            Remove
                        </Button>
                    </li>
                ))}
            </ul>
            <Button
                className="mt-4"
                disabled={factorCapacityReached || action.busy}
                onClick={() => setLabelModalOpen(true)}
            >
                <Icon icon={Smartphone} size="sm" tone="inherit" />
                Add authenticator app
            </Button>
            {labelModalOpen && (
                <MfaEnrollmentLabelModal
                    busy={action.busy}
                    busyLabel="Starting setup…"
                    description="Give this authenticator a name so you can recognize it later. You can leave the name blank."
                    icon={Smartphone}
                    inputLabel="Name"
                    onClose={() => setLabelModalOpen(false)}
                    onSubmit={beginEnrollment}
                    placeholder="Example: Phone authenticator"
                    submitLabel="Continue"
                    title="Add authenticator app"
                />
            )}
            {enrollment !== undefined && (
                <OneTimeSecretPanel
                    id="totp-enrollment-secret"
                    onDismiss={dismissEnrollment}
                    title="Finish authenticator app setup"
                >
                    <div className="font-sans">
                        <p className="mb-3 text-sm text-amber-50">
                            Scan this QR code with your authenticator app. If you cannot
                            scan it, enter the setup key shown below.
                        </p>
                        <div className="inline-flex rounded-lg bg-white p-2">
                            <QRCodeSVG
                                marginSize={4}
                                size={176}
                                title="Authenticator enrollment QR code"
                                value={enrollment.otpauthUri}
                            />
                        </div>
                        <p className="mt-3 text-xs font-medium tracking-wide text-amber-200 uppercase">
                            Setup key
                        </p>
                        <p className="mt-1 font-mono text-sm break-all">
                            {enrollment.secret}
                        </p>
                        <p className="mt-3 text-xs font-medium tracking-wide text-amber-200 uppercase">
                            Setup link
                        </p>
                        <p className="mt-1 font-mono text-xs break-all">
                            {enrollment.otpauthUri}
                        </p>
                        <Form
                            className="mt-4"
                            onSubmit={() => void confirmationForm.handleSubmit()}
                        >
                            <confirmationForm.Field name="code">
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
                                            placeholder="123456"
                                            required
                                            value={field.state.value}
                                        />
                                    </FormField>
                                )}
                            </confirmationForm.Field>
                            <confirmationForm.Subscribe
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
                            </confirmationForm.Subscribe>
                        </Form>
                    </div>
                </OneTimeSecretPanel>
            )}
        </div>
    );
}
