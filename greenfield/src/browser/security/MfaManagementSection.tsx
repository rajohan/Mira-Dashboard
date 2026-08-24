import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type {
    AccountSecuritySummary,
    TotpEnrollment,
} from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { MfaRecoveryControls } from "./MfaRecoveryControls.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { OneTimeSecretPanel, SecuritySection } from "./SecurityUi.tsx";
import { TotpFactorManagement } from "./TotpFactorManagement.tsx";
import { WebAuthnFactorManagement } from "./WebAuthnFactorManagement.tsx";

type MfaConfirmation =
    | Readonly<{ factorId: string; kind: "remove-totp"; label: string }>
    | Readonly<{ credentialId: string; kind: "remove-webauthn"; label: string }>
    | Readonly<{ kind: "rotate-recovery-codes" }>;

function mfaConfirmationCopy(confirmation: MfaConfirmation) {
    switch (confirmation.kind) {
        case "remove-totp": {
            return {
                confirmLabel: "Remove authenticator",
                description: `You will no longer be able to use “${confirmation.label}” to confirm your identity.`,
                title: "Remove authenticator?",
            };
        }
        case "remove-webauthn": {
            return {
                confirmLabel: "Remove security key",
                description: `You will no longer be able to use “${confirmation.label}” to confirm your identity.`,
                title: "Remove security key?",
            };
        }
        case "rotate-recovery-codes": {
            return {
                confirmLabel: "Create new recovery codes",
                description:
                    "Every current recovery code will stop working and a new one-time set will be shown.",
                title: "Create new recovery codes?",
            };
        }
    }
}

interface MfaManagementSectionProps {
    readonly summary: AccountSecuritySummary;
}

/**
 * Coordinates possession-factor and recovery controls with one exclusive action boundary.
 * @returns The MFA management section.
 */
export function MfaManagementSection({ summary }: MfaManagementSectionProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [confirmation, setConfirmation] = useState<MfaConfirmation>();
    const [recoveryCodes, setRecoveryCodes] = useState<readonly string[]>();
    const [totpEnrollment, setTotpEnrollment] = useState<TotpEnrollment>();

    async function refreshAfter(operation: () => Promise<unknown>): Promise<boolean> {
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        return result.status === "success";
    }

    async function disableMfa(password: string): Promise<boolean> {
        const succeeded = await refreshAfter(() =>
            client.mutation("accountSecurity.disableMfa", { password })
        );
        if (succeeded) {
            setRecoveryCodes(undefined);
            setTotpEnrollment(undefined);
        }
        return succeeded;
    }

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

    async function confirmMfaAction() {
        const pendingConfirmation = confirmation;
        if (pendingConfirmation === undefined) return;
        try {
            switch (pendingConfirmation.kind) {
                case "remove-totp": {
                    await removeTotp(pendingConfirmation.factorId);
                    break;
                }
                case "remove-webauthn": {
                    await removeWebAuthn(pendingConfirmation.credentialId);
                    break;
                }
                case "rotate-recovery-codes": {
                    await rotateRecoveryCodes();
                    break;
                }
            }
        } finally {
            setConfirmation(undefined);
        }
    }

    const confirmationCopy =
        confirmation === undefined ? undefined : mfaConfirmationCopy(confirmation);
    const factorCount =
        summary.mfa.totpFactors.length + summary.mfa.webAuthnCredentials.length;
    const factorCapacityReached = factorCount >= 4;

    return (
        <SecuritySection
            description="Add or remove authenticator apps and security keys. Save recovery codes when they are shown because they cannot be viewed again."
            id="mfa-management-heading"
            title="Multi-factor authentication"
        >
            <Alert className="mb-4" message={action.error} />
            <p className="text-primary-300 text-sm">
                Status: {summary.mfa.enabled ? "Enabled" : "Disabled"} · {factorCount} of
                4 sign-in methods set up
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
                <TotpFactorManagement
                    action={action}
                    enrollment={totpEnrollment}
                    factorCapacityReached={factorCapacityReached}
                    factors={summary.mfa.totpFactors}
                    onEnrollmentChange={setTotpEnrollment}
                    onRecoveryCodes={setRecoveryCodes}
                    onRemove={(factor) =>
                        setConfirmation({
                            factorId: factor.id,
                            kind: "remove-totp",
                            label: factor.label,
                        })
                    }
                    refreshAfter={refreshAfter}
                />
                <WebAuthnFactorManagement
                    action={action}
                    available={summary.webAuthn.available}
                    credentials={summary.mfa.webAuthnCredentials}
                    factorCapacityReached={factorCapacityReached}
                    onRecoveryCodes={setRecoveryCodes}
                    onRemove={(credential) =>
                        setConfirmation({
                            credentialId: credential.id,
                            kind: "remove-webauthn",
                            label: credential.label,
                        })
                    }
                    refreshAfter={refreshAfter}
                />
            </div>
            {summary.mfa.enabled && (
                <MfaRecoveryControls
                    action={action}
                    onDisable={disableMfa}
                    onRequestRecoveryCodeRotation={() =>
                        setConfirmation({ kind: "rotate-recovery-codes" })
                    }
                />
            )}
            <ConfirmModal
                busy={action.busy}
                confirmLabel={confirmationCopy?.confirmLabel}
                danger
                description={confirmationCopy?.description ?? ""}
                onCancel={() => setConfirmation(undefined)}
                onConfirm={() => void confirmMfaAction()}
                open={confirmation !== undefined}
                title={confirmationCopy?.title ?? "Confirm MFA action"}
            />
        </SecuritySection>
    );
}
