import { useQueryClient } from "@tanstack/react-query";
import { KeyRound, ShieldOff } from "lucide-react";
import { useState } from "react";

import type { AutomationPrincipalSummary } from "../../contracts/automationSecurity.ts";
import type { ApplicationCapability } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { AutomationCapabilityPicker } from "./AutomationCapabilityPicker.tsx";
import { AutomationCredentialPanel } from "./AutomationCredentialPanel.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { OneTimeSecretPanel } from "./SecurityUi.tsx";

interface AutomationPrincipalCardProps {
    readonly principal: AutomationPrincipalSummary;
}

/**
 * Renders one automation principal and its mutable security controls.
 * @returns A principal card with capability and credential management.
 */
export function AutomationPrincipalCard({ principal }: AutomationPrincipalCardProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [capabilities, setCapabilities] = useState<ApplicationCapability[]>([
        ...principal.capabilities,
    ]);
    const [disableConfirmationOpen, setDisableConfirmationOpen] = useState(false);
    const [issuedToken, setIssuedToken] = useState<string>();

    async function replaceCapabilities() {
        const result = await action.run(async () => {
            const updated = await client.mutation(
                "automationSecurity.replaceCapabilities",
                {
                    capabilities,
                    expectedAuthorizationVersion: principal.authorizationVersion,
                    principalId: principal.id,
                }
            );
            await refreshSecurityQueries(queryClient);
            return updated.principal.capabilities;
        });
        if (result.status === "success") setCapabilities([...result.value]);
    }

    async function disablePrincipal() {
        try {
            await action.run(async () => {
                await client.mutation("automationSecurity.disablePrincipal", {
                    expectedAuthorizationVersion: principal.authorizationVersion,
                    principalId: principal.id,
                });
                await refreshSecurityQueries(queryClient);
            });
        } finally {
            setDisableConfirmationOpen(false);
        }
    }

    return (
        <li className="border-primary-700 rounded-xl border p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                    <Heading level={3}>{principal.label}</Heading>
                    <p className="text-primary-400 mt-1 font-mono text-sm">
                        {principal.id}
                    </p>
                    <p className="text-primary-400 mt-1 text-sm">
                        {principal.disabled ? "Disabled" : "Active"} ·{" "}
                        {principal.activeCredentialCount} active credential(s)
                    </p>
                </div>
                {!principal.disabled && (
                    <Button
                        aria-label={`Disable principal ${principal.label}`}
                        busy={action.busy}
                        busyLabel="Disabling…"
                        onClick={() => setDisableConfirmationOpen(true)}
                        size="sm"
                        variant="danger"
                    >
                        <Icon icon={ShieldOff} size="sm" tone="inherit" />
                        Disable principal
                    </Button>
                )}
            </div>
            <Alert className="mt-4" message={action.error} />
            {issuedToken !== undefined && (
                <OneTimeSecretPanel
                    id={`automation-token-${principal.id}`}
                    onDismiss={() => setIssuedToken(undefined)}
                    title="New automation token"
                >
                    {issuedToken}
                </OneTimeSecretPanel>
            )}
            <AutomationCapabilityPicker
                disabled={principal.disabled || action.busy}
                onChange={setCapabilities}
                value={capabilities}
            />
            {!principal.disabled && (
                <Button
                    busy={action.busy}
                    busyLabel="Updating…"
                    className="mt-3"
                    onClick={() => void replaceCapabilities()}
                    size="sm"
                    variant="secondary"
                >
                    Replace capabilities
                </Button>
            )}
            <ExpandableCard
                className="mt-5"
                description="Create, stage, rotate, or revoke scoped credentials."
                icon={KeyRound}
                title="Manage credentials"
            >
                <AutomationCredentialPanel
                    onIssuedToken={setIssuedToken}
                    principal={principal}
                />
            </ExpandableCard>
            <ConfirmModal
                busy={action.busy}
                confirmLabel="Disable principal"
                danger
                description={`Disable “${principal.label}” and revoke every active credential it owns.`}
                onCancel={() => setDisableConfirmationOpen(false)}
                onConfirm={() => void disablePrincipal()}
                open={disableConfirmationOpen}
                title="Disable automation principal?"
            />
        </li>
    );
}
