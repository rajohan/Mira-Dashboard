import { useQueryClient } from "@tanstack/react-query";
import { ShieldOff } from "lucide-react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { MfaRecoveryControls } from "./MfaRecoveryControls.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

interface MfaDisableSectionProps {
    readonly summary: AccountSecuritySummary;
}

/**
 * Keeps two-step-login removal after active-session management in page order.
 * @returns The MFA danger section when two-step login is enabled.
 */
export function MfaDisableSection({ summary }: MfaDisableSectionProps) {
    const action = useExclusiveDashboardAction();
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();

    if (!summary.mfa.enabled) return null;

    async function disableMfa(password: string): Promise<boolean> {
        const result = await action.run(async () => {
            await client.mutation("accountSecurity.disableMfa", { password });
            await refreshSecurityQueries(queryClient);
        });
        return result.status === "success";
    }

    return (
        <SecuritySection
            actions={<MfaRecoveryControls action={action} onDisable={disableMfa} />}
            className="border-red-800/60"
            description="Remove every security key, authenticator app, and recovery code. Every browser will be signed out."
            id="mfa-disable-heading"
            icon={ShieldOff}
            title="Disable two-step login"
        />
    );
}
