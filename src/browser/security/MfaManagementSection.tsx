import { useQueryClient } from "@tanstack/react-query";
import { Fingerprint, Plus, RefreshCw, ShieldCheck, Smartphone } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type {
    AccountSecuritySummary,
    TotpEnrollment,
} from "../../contracts/accountSecurity.ts";
import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { useRecoveryCodesPresenter } from "./recoveryCodesPresentationContextValue.ts";
import {
    accountSecuritySummaryQueryOptions,
    refreshSecurityQueries,
} from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";
import { useSecurityVerificationCoordinator } from "./securityVerificationContextValue.ts";
import type { SecurityVerificationWaiterLease } from "./securityVerificationCoordinator.ts";
import { TotpFactorManagement } from "./TotpFactorManagement.tsx";
import { WebAuthnFactorManagement } from "./WebAuthnFactorManagement.tsx";

type MfaConfirmation =
    | Readonly<{ factorId: string; kind: "remove-totp"; label: string }>
    | Readonly<{ credentialId: string; kind: "remove-webauthn"; label: string }>
    | Readonly<{ kind: "rotate-recovery-codes" }>;

type MfaEnrollmentKind = "totp" | "webauthn";

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
    const recoveryCodesPresenter = useRecoveryCodesPresenter();
    const securityVerification = useSecurityVerificationCoordinator();
    const [confirmation, setConfirmation] = useState<MfaConfirmation>();
    const [enrollmentLabelKind, setEnrollmentLabelKind] = useState<MfaEnrollmentKind>();
    const [totpEnrollment, setTotpEnrollment] = useState<TotpEnrollment>();
    const enrollmentOwnerUserId = useRef<string | undefined>(undefined);
    const preparedEnrollment = useRef<
        | Readonly<{
              controller: AbortController;
              lease: SecurityVerificationWaiterLease;
          }>
        | undefined
    >(undefined);

    function releaseEnrollmentPreparation(): void {
        setEnrollmentLabelKind(undefined);
        enrollmentOwnerUserId.current = undefined;
        const prepared = preparedEnrollment.current;
        if (prepared === undefined) return;
        preparedEnrollment.current = undefined;
        prepared.lease.releaseAfterAttempt();
    }

    function showEnrollmentRecoveryCodes(codes: readonly string[]): void {
        const ownerUserId = enrollmentOwnerUserId.current;
        if (ownerUserId !== undefined) {
            recoveryCodesPresenter.present(ownerUserId, codes);
        }
    }

    useEffect(
        () => () => {
            const prepared = preparedEnrollment.current;
            preparedEnrollment.current = undefined;
            prepared?.controller.abort();
            prepared?.lease.releaseAfterAttempt();
        },
        []
    );

    async function prepareEnrollment(): Promise<boolean> {
        const authentication = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
        if (authentication?.state !== "authenticated") return false;
        enrollmentOwnerUserId.current = authentication.user.id;
        const result = await action.run(async () => {
            const currentSummary = await queryClient.fetchQuery(
                accountSecuritySummaryQueryOptions(client)
            );
            const recentVerification = currentSummary.mfa.enabled
                ? currentSummary.recentAuth.mfa
                : currentSummary.recentAuth.password;
            if (securityVerification === undefined) return true;

            const controller = new AbortController();
            const lease = securityVerification.prepareProtectedInteraction(
                "step_up_required",
                {
                    proofAlreadyRecent: recentVerification.recent,
                    signal: controller.signal,
                }
            );
            if (lease === undefined) return false;
            preparedEnrollment.current = { controller, lease };
            const outcome = await lease.outcome;
            if (outcome === "verified") return true;
            if (preparedEnrollment.current?.lease === lease) {
                preparedEnrollment.current = undefined;
            }
            lease.releaseAfterAttempt();
            return false;
        });
        const prepared = result.status === "success" && result.value;
        if (!prepared) enrollmentOwnerUserId.current = undefined;
        return prepared;
    }

    async function openEnrollmentLabel(kind: MfaEnrollmentKind): Promise<void> {
        if (await prepareEnrollment()) setEnrollmentLabelKind(kind);
    }

    async function refreshAfter(operation: () => Promise<unknown>): Promise<boolean> {
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        return result.status === "success";
    }

    async function rotateRecoveryCodes(): Promise<
        Readonly<{ codes: readonly string[]; ownerUserId: string }> | undefined
    > {
        const authentication = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
        if (authentication?.state !== "authenticated") return undefined;
        let codes: readonly string[] | undefined;
        const succeeded = await refreshAfter(async () => {
            const result = await client.mutation(
                "accountSecurity.rotateRecoveryCodes",
                {}
            );
            codes = result.recoveryCodes;
        });
        return succeeded && codes !== undefined
            ? { codes, ownerUserId: authentication.user.id }
            : undefined;
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
        let recoveryCodes:
            | Readonly<{ codes: readonly string[]; ownerUserId: string }>
            | undefined;
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
                    recoveryCodes = await rotateRecoveryCodes();
                    break;
                }
            }
        } finally {
            setConfirmation(undefined);
        }
        if (recoveryCodes !== undefined) {
            recoveryCodesPresenter.present(
                recoveryCodes.ownerUserId,
                recoveryCodes.codes
            );
        }
    }

    const confirmationCopy =
        confirmation === undefined ? undefined : mfaConfirmationCopy(confirmation);
    const factorCount =
        summary.mfa.totpFactors.length + summary.mfa.webAuthnCredentials.length;
    const factorCapacityReached = factorCount >= 4;

    return (
        <div className="contents">
            <Heading className="sr-only" id="mfa-management-heading" level={2}>
                Multi-factor authentication
            </Heading>
            <Alert message={action.error} />
            <div className="grid gap-4 xl:grid-cols-2">
                <SecuritySection
                    actions={
                        summary.webAuthn.available ? (
                            <Button
                                aria-label="Add security key"
                                className="w-full sm:w-auto"
                                disabled={factorCapacityReached || action.busy}
                                onClick={() => void openEnrollmentLabel("webauthn")}
                                size="sm"
                            >
                                <Icon icon={Plus} size="sm" tone="inherit" />
                                Add
                            </Button>
                        ) : undefined
                    }
                    description="Register named security keys and keep a backup key separately."
                    id="webauthn-management-heading"
                    icon={Fingerprint}
                    title="Security keys"
                >
                    <WebAuthnFactorManagement
                        action={action}
                        available={summary.webAuthn.available}
                        credentials={summary.mfa.webAuthnCredentials}
                        labelModalOpen={enrollmentLabelKind === "webauthn"}
                        onEnrollmentLabelClose={() => setEnrollmentLabelKind(undefined)}
                        onRecoveryCodes={showEnrollmentRecoveryCodes}
                        onRemove={(credential) =>
                            setConfirmation({
                                credentialId: credential.id,
                                kind: "remove-webauthn",
                                label: credential.label,
                            })
                        }
                        onEnrollmentFlowComplete={releaseEnrollmentPreparation}
                        refreshAfter={refreshAfter}
                    />
                </SecuritySection>
                <SecuritySection
                    actions={
                        <Button
                            aria-label="Add authenticator app"
                            className="w-full sm:w-auto"
                            disabled={factorCapacityReached || action.busy}
                            onClick={() => void openEnrollmentLabel("totp")}
                            size="sm"
                        >
                            <Icon icon={Plus} size="sm" tone="inherit" />
                            Add
                        </Button>
                    }
                    description="Use a standard 6-digit authenticator code as a second factor."
                    id="totp-management-heading"
                    icon={Smartphone}
                    title="Authenticator apps"
                >
                    <TotpFactorManagement
                        action={action}
                        enrollment={totpEnrollment}
                        factors={summary.mfa.totpFactors}
                        labelModalOpen={enrollmentLabelKind === "totp"}
                        onEnrollmentChange={setTotpEnrollment}
                        onEnrollmentLabelClose={() => setEnrollmentLabelKind(undefined)}
                        onEnrollmentFlowComplete={releaseEnrollmentPreparation}
                        onRecoveryCodes={showEnrollmentRecoveryCodes}
                        onRemove={(factor) =>
                            setConfirmation({
                                factorId: factor.id,
                                kind: "remove-totp",
                                label: factor.label,
                            })
                        }
                        refreshAfter={refreshAfter}
                    />
                </SecuritySection>
            </div>
            <SecuritySection
                actions={
                    <Button
                        busy={action.busy}
                        busyLabel="Creating…"
                        disabled={!summary.mfa.enabled}
                        onClick={() => setConfirmation({ kind: "rotate-recovery-codes" })}
                        variant="secondary"
                    >
                        <Icon icon={RefreshCw} size="sm" tone="inherit" />
                        Create new codes
                    </Button>
                }
                badge={
                    <Badge variant={summary.mfa.enabled ? "success" : "default"}>
                        {summary.mfa.recoveryCodesRemaining} unused
                    </Badge>
                }
                description="Store these one-time codes offline. Full codes are shown only when generated."
                id="mfa-recovery-heading"
                icon={ShieldCheck}
                title="Recovery codes"
            />
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
        </div>
    );
}
