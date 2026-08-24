import { useQueryClient } from "@tanstack/react-query";
import { Bot, KeyRound, ShieldOff } from "lucide-react";
import { useState } from "react";

import type { AutomationPrincipalSummary } from "../../contracts/automationSecurity.ts";
import type { ApplicationCapability } from "../../contracts/security.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Icon } from "../ui/Icon.tsx";
import { AutomationCapabilityPicker } from "./AutomationCapabilityPicker.tsx";
import { AutomationCredentialPanel } from "./AutomationCredentialPanel.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";

interface AutomationPrincipalCardProps {
    readonly principal: AutomationPrincipalSummary;
}

interface AutomationCapabilityEditorProps {
    readonly busy: boolean;
    readonly disabled: boolean;
    readonly initialCapabilities: readonly ApplicationCapability[];
    readonly onReplace: (capabilities: ApplicationCapability[]) => Promise<void>;
}

/**
 * Owns an editable capability draft for one exact server authorization version.
 * @returns Capability controls that reset when their keyed server version changes.
 */
function AutomationCapabilityEditor({
    busy,
    disabled,
    initialCapabilities,
    onReplace,
}: AutomationCapabilityEditorProps) {
    const [capabilities, setCapabilities] = useState<ApplicationCapability[]>([
        ...initialCapabilities,
    ]);

    return (
        <>
            <AutomationCapabilityPicker
                disabled={disabled || busy}
                onChange={setCapabilities}
                value={capabilities}
            />
            {!disabled && (
                <Button
                    busy={busy}
                    busyLabel="Updating…"
                    className="mt-3"
                    onClick={() => void onReplace(capabilities)}
                    size="sm"
                    variant="secondary"
                >
                    Update permissions
                </Button>
            )}
        </>
    );
}

/**
 * Renders one automation principal and its mutable security controls.
 * @returns A principal card with capability and credential management.
 */
export function AutomationPrincipalCard({ principal }: AutomationPrincipalCardProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const [disableConfirmationOpen, setDisableConfirmationOpen] = useState(false);

    async function replaceCapabilities(capabilities: ApplicationCapability[]) {
        await action.run(async () => {
            await client.mutation("automationSecurity.replaceCapabilities", {
                capabilities,
                expectedAuthorizationVersion: principal.authorizationVersion,
                principalId: principal.id,
            });
            await refreshSecurityQueries(queryClient);
        });
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
        <ExpandableCard
            description={
                <>
                    <span className="block font-mono">{principal.id}</span>
                    <span className="mt-1 block">
                        {principal.disabled ? "Disabled" : "Active"} ·{" "}
                        {principal.activeCredentialCount} active access token(s)
                    </span>
                </>
            }
            icon={Bot}
            title={principal.label}
        >
            <div className="flex justify-end">
                {!principal.disabled && (
                    <Button
                        aria-label={`Disable automation account ${principal.label}`}
                        busy={action.busy}
                        busyLabel="Disabling…"
                        onClick={() => setDisableConfirmationOpen(true)}
                        size="sm"
                        variant="danger"
                    >
                        <Icon icon={ShieldOff} size="sm" tone="inherit" />
                        Disable account
                    </Button>
                )}
            </div>
            <Alert className="mt-4" message={action.error} />
            <AutomationCapabilityEditor
                busy={action.busy}
                disabled={principal.disabled}
                initialCapabilities={principal.capabilities}
                key={`${principal.id}:${principal.authorizationVersion}`}
                onReplace={replaceCapabilities}
            />
            <ExpandableCard
                className="mt-5"
                description="Create, replace, or revoke access tokens for this automation account."
                icon={KeyRound}
                title="Manage access tokens"
            >
                <AutomationCredentialPanel principal={principal} />
            </ExpandableCard>
            <ConfirmModal
                busy={action.busy}
                confirmLabel="Disable account"
                danger
                description={`Disable “${principal.label}” and revoke all of its active access tokens.`}
                onCancel={() => setDisableConfirmationOpen(false)}
                onConfirm={() => void disablePrincipal()}
                open={disableConfirmationOpen}
                title="Disable automation account?"
            />
        </ExpandableCard>
    );
}
