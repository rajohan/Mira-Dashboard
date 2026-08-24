import { Fingerprint, Trash2 } from "lucide-react";
import { useRef } from "react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { MfaEnrollmentLabelModal } from "./MfaEnrollmentLabelModal.tsx";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface WebAuthnFactorManagementProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly available: boolean;
    readonly credentials: AccountSecuritySummary["mfa"]["webAuthnCredentials"];
    readonly labelModalOpen: boolean;
    readonly onEnrollmentLabelClose: () => void;
    readonly onEnrollmentFlowComplete: () => void;
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
    readonly onRemove: (credential: Readonly<{ id: string; label: string }>) => void;
    readonly refreshAfter: (operation: () => Promise<unknown>) => Promise<boolean>;
}

/**
 * Manages WebAuthn security-key inventory and registration ceremonies.
 * @returns Security-key inventory and enrollment controls.
 */
export function WebAuthnFactorManagement({
    action,
    available,
    credentials,
    labelModalOpen,
    onEnrollmentLabelClose,
    onEnrollmentFlowComplete,
    onRecoveryCodes,
    onRemove,
    refreshAfter,
}: WebAuthnFactorManagementProps) {
    const client = useDashboardTrpcClient();
    const webAuthn = useDashboardWebAuthnClient();
    const pendingRecoveryCodes = useRef<readonly string[] | undefined>(undefined);

    async function enrollSecurityKey(label: string): Promise<boolean> {
        const succeeded = await refreshAfter(async () => {
            const challenge = await client.mutation(
                "accountSecurity.beginWebAuthnEnrollment",
                {}
            );
            const response = await webAuthn.register(challenge.options);
            const result = await client.mutation(
                "accountSecurity.confirmWebAuthnEnrollment",
                label.length === 0 ? { response } : { label, response }
            );
            pendingRecoveryCodes.current = result.enabledNow
                ? result.recoveryCodes
                : undefined;
        });
        return succeeded || pendingRecoveryCodes.current !== undefined;
    }

    function closeEnrollmentFlow(): void {
        onEnrollmentLabelClose();
        const recoveryCodes = pendingRecoveryCodes.current;
        pendingRecoveryCodes.current = undefined;
        if (recoveryCodes !== undefined) onRecoveryCodes(recoveryCodes);
        onEnrollmentFlowComplete();
    }

    return (
        <div>
            <ul className="space-y-2">
                {credentials.map((credential) => (
                    <li
                        className="border-primary-700 bg-primary-900/40 flex items-start justify-between gap-3 rounded-lg border p-3 text-sm"
                        key={credential.id}
                    >
                        <div className="min-w-0">
                            <p className="text-primary-100 truncate font-medium">
                                {credential.label}
                            </p>
                            <p className="text-primary-400 mt-1">
                                Added {formatDashboardDateTime(credential.createdAtMs)} ·
                                {credential.usable ? " ready to use" : " unavailable"}
                            </p>
                        </div>
                        <IconOnlyButton
                            className="self-center"
                            disabled={action.busy}
                            icon={Trash2}
                            label={`Remove security key ${credential.label}`}
                            onClick={() => onRemove(credential)}
                            variant="danger"
                        />
                    </li>
                ))}
            </ul>
            {credentials.length === 0 && (
                <p className="text-primary-400 py-2 text-sm">
                    No security keys registered.
                </p>
            )}
            {labelModalOpen && (
                <MfaEnrollmentLabelModal
                    busy={action.busy}
                    busyLabel="Waiting for your security key…"
                    description="Give this key a name so you can recognize it later. You can leave the name blank."
                    icon={Fingerprint}
                    inputLabel="Name"
                    onCancel={closeEnrollmentFlow}
                    onCompleted={closeEnrollmentFlow}
                    onSubmit={enrollSecurityKey}
                    placeholder="Primary security key"
                    submitLabel="Continue"
                    title="Add security key"
                />
            )}
            {!available && (
                <p className="text-primary-400 mt-3 text-sm">
                    Security keys are not available in this browser or at this address.
                </p>
            )}
        </div>
    );
}
