import { Fingerprint, Trash2 } from "lucide-react";
import { useState } from "react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import type { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Button } from "../ui/Button.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { MfaEnrollmentLabelModal } from "./MfaEnrollmentLabelModal.tsx";
import { useDashboardWebAuthnClient } from "./webauthn/webauthnContextValue.ts";

interface WebAuthnFactorManagementProps {
    readonly action: ReturnType<typeof useExclusiveDashboardAction>;
    readonly available: boolean;
    readonly credentials: AccountSecuritySummary["mfa"]["webAuthnCredentials"];
    readonly factorCapacityReached: boolean;
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
    factorCapacityReached,
    onRecoveryCodes,
    onRemove,
    refreshAfter,
}: WebAuthnFactorManagementProps) {
    const client = useDashboardTrpcClient();
    const webAuthn = useDashboardWebAuthnClient();
    const [labelModalOpen, setLabelModalOpen] = useState(false);

    async function enrollSecurityKey(label: string): Promise<boolean> {
        return refreshAfter(async () => {
            const challenge = await client.mutation(
                "accountSecurity.beginWebAuthnEnrollment",
                {}
            );
            const response = await webAuthn.register(challenge.options);
            const result = await client.mutation(
                "accountSecurity.confirmWebAuthnEnrollment",
                label.length === 0 ? { response } : { label, response }
            );
            if (result.enabledNow) onRecoveryCodes(result.recoveryCodes);
        });
    }

    return (
        <div>
            <Heading level={3}>Security keys</Heading>
            <ul className="mt-3 space-y-3">
                {credentials.map((credential) => (
                    <li
                        className="border-primary-700 rounded-lg border p-3 text-sm"
                        key={credential.id}
                    >
                        <p className="text-primary-100 font-medium">{credential.label}</p>
                        <p className="text-primary-400 mt-1">
                            Added {formatDashboardDateTime(credential.createdAtMs)} ·
                            {credential.usable ? " ready to use" : " unavailable"}
                        </p>
                        <Button
                            aria-label={`Remove security key ${credential.label}`}
                            busy={action.busy}
                            busyLabel="Removing…"
                            className="mt-3"
                            onClick={() => onRemove(credential)}
                            size="sm"
                            variant="danger"
                        >
                            <Icon icon={Trash2} size="sm" tone="inherit" />
                            Remove
                        </Button>
                    </li>
                ))}
            </ul>
            {available ? (
                <>
                    <Button
                        className="mt-4"
                        disabled={factorCapacityReached || action.busy}
                        onClick={() => setLabelModalOpen(true)}
                    >
                        <Icon icon={Fingerprint} size="sm" tone="inherit" />
                        Add security key
                    </Button>
                    {labelModalOpen && (
                        <MfaEnrollmentLabelModal
                            busy={action.busy}
                            busyLabel="Waiting for your security key…"
                            description="Give this key a name so you can recognize it later. You can leave the name blank."
                            icon={Fingerprint}
                            inputLabel="Name"
                            onClose={() => setLabelModalOpen(false)}
                            onSubmit={enrollSecurityKey}
                            placeholder="Example: Primary security key"
                            submitLabel="Continue"
                            title="Add security key"
                        />
                    )}
                </>
            ) : (
                <p className="text-primary-400 mt-3 text-sm">
                    Security keys are not available in this browser or at this address.
                </p>
            )}
        </div>
    );
}
