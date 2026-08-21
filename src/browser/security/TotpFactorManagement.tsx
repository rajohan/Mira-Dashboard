import { useForm } from "@tanstack/react-form";
import { Smartphone, Trash2 } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";

import {
    totpStepUpInputSchema,
    type AccountSecuritySummary,
    type TotpEnrollment,
} from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Button } from "../ui/Button.tsx";
import { CopyTextButton } from "../ui/CopyTextButton.tsx";
import { Form } from "../ui/Form.tsx";
import { firstFormFieldError } from "../ui/formErrors.ts";
import { FormField } from "../ui/FormField.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Input } from "../ui/Input.tsx";
import { Modal } from "../ui/Modal.tsx";
import { MfaEnrollmentLabelModal } from "./MfaEnrollmentLabelModal.tsx";

interface TotpFactorManagementProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly enrollment: TotpEnrollment | undefined;
    readonly factors: AccountSecuritySummary["mfa"]["totpFactors"];
    readonly labelModalOpen: boolean;
    readonly onEnrollmentChange: (enrollment: TotpEnrollment | undefined) => void;
    readonly onEnrollmentLabelClose: () => void;
    readonly onEnrollmentFlowComplete: () => void;
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
    factors,
    labelModalOpen,
    onEnrollmentChange,
    onEnrollmentLabelClose,
    onEnrollmentFlowComplete,
    onRecoveryCodes,
    onRemove,
    refreshAfter,
}: TotpFactorManagementProps) {
    const client = useDashboardTrpcClient();
    const confirmationForm = useForm({
        defaultValues: { code: "" },
        onSubmit: async ({ formApi, value }) => {
            if (enrollment === undefined) return;
            let recoveryCodes: readonly string[] | undefined;
            const succeeded = await refreshAfter(async () => {
                const result = await client.mutation(
                    "accountSecurity.confirmTotpEnrollment",
                    { code: value.code, factorId: enrollment.factorId }
                );
                if (result.enabledNow) recoveryCodes = result.recoveryCodes;
            });
            if (succeeded || recoveryCodes !== undefined) {
                formApi.setFieldValue("code", "");
                onEnrollmentChange(undefined);
                if (recoveryCodes !== undefined) onRecoveryCodes(recoveryCodes);
                onEnrollmentFlowComplete();
            }
        },
        validators: { onSubmit: totpStepUpInputSchema },
    });

    function dismissEnrollment() {
        confirmationForm.setFieldValue("code", "");
        onEnrollmentChange(undefined);
        onEnrollmentFlowComplete();
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

    function cancelLabelStep(): void {
        onEnrollmentLabelClose();
        onEnrollmentFlowComplete();
    }

    return (
        <div>
            <ul className="space-y-2">
                {factors.map((factor) => (
                    <li
                        className="border-primary-700 bg-primary-900/40 flex items-start justify-between gap-3 rounded-lg border p-3 text-sm"
                        key={factor.id}
                    >
                        <div className="min-w-0">
                            <p className="text-primary-100 truncate font-medium">
                                {factor.label}
                            </p>
                            <p className="text-primary-400 mt-1">
                                Confirmed {formatDashboardDateTime(factor.confirmedAtMs)}
                            </p>
                        </div>
                        <IconOnlyButton
                            className="self-center"
                            disabled={action.busy}
                            icon={Trash2}
                            label={`Remove authenticator ${factor.label}`}
                            onClick={() => onRemove(factor)}
                            variant="danger"
                        />
                    </li>
                ))}
            </ul>
            {factors.length === 0 && (
                <p className="text-primary-400 py-2 text-sm">
                    No authenticator apps registered.
                </p>
            )}
            {labelModalOpen && (
                <MfaEnrollmentLabelModal
                    busy={action.busy}
                    busyLabel="Starting setup…"
                    description="Give this authenticator a name so you can recognize it later. You can leave the name blank."
                    icon={Smartphone}
                    inputLabel="Name"
                    onCancel={cancelLabelStep}
                    onCompleted={onEnrollmentLabelClose}
                    onSubmit={beginEnrollment}
                    placeholder="Phone authenticator"
                    submitLabel="Continue"
                    title="Add authenticator app"
                />
            )}
            {enrollment !== undefined && (
                <Modal
                    description="Scan the QR code, or enter the setup key manually, then confirm with a code from your authenticator app."
                    dismissible={!action.busy}
                    onClose={dismissEnrollment}
                    open
                    size="sm"
                    title="Finish authenticator app setup"
                >
                    <div>
                        <div className="flex justify-center">
                            <div className="inline-flex rounded-lg bg-white p-3">
                                <QRCodeSVG
                                    marginSize={4}
                                    size={192}
                                    title="Authenticator enrollment QR code"
                                    value={enrollment.otpauthUri}
                                />
                            </div>
                        </div>
                        <div className="mt-5 min-w-0">
                            <p className="text-primary-200 block text-sm font-medium">
                                Manual setup key
                            </p>
                            <div className="border-primary-700 bg-primary-900 mt-2 flex min-w-0 items-center gap-2 rounded-lg border p-2">
                                <code className="text-primary-100 min-w-0 flex-1 p-1 font-mono text-xs break-all select-all">
                                    {enrollment.secret}
                                </code>
                                <CopyTextButton
                                    iconOnly
                                    label="Copy setup key"
                                    text={enrollment.secret}
                                />
                            </div>
                        </div>
                        <Form
                            className="mt-5"
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
                                            data-autofocus
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
                                    <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                                        <Button
                                            disabled={action.busy || isSubmitting}
                                            onClick={dismissEnrollment}
                                            type="button"
                                            variant="secondary"
                                        >
                                            Cancel
                                        </Button>
                                        <Button
                                            busy={action.busy || isSubmitting}
                                            busyLabel="Confirming…"
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
                                    </div>
                                )}
                            </confirmationForm.Subscribe>
                        </Form>
                    </div>
                </Modal>
            )}
        </div>
    );
}
