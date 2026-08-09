import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import type { AccountSecuritySummary } from "../../contracts/accountSecurity.ts";
import type { MultiFactorAuthenticationMethod } from "../../contracts/security.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { Alert } from "../ui/Alert.tsx";
import { PasswordChangeForm } from "./PasswordChangeForm.tsx";
import { SecurityProofControls } from "./SecurityProofControls.tsx";
import { refreshSecurityQueries } from "./securityQueries.ts";
import { SecuritySection } from "./SecurityUi.tsx";

interface SecurityVerificationSectionProps {
    readonly summary: AccountSecuritySummary;
}

/**
 * Coordinates recent-auth proofs and password rotation without caching secrets.
 * @returns The verification management section.
 */
export function SecurityVerificationSection({
    summary,
}: SecurityVerificationSectionProps) {
    const action = useExclusiveDashboardAction();
    const queryClient = useQueryClient();
    const [notice, setNotice] = useState<string>();

    async function complete(
        operation: () => Promise<unknown>,
        successMessage: string
    ): Promise<void> {
        setNotice(undefined);
        const result = await action.run(async () => {
            await operation();
            await refreshSecurityQueries(queryClient);
        });
        if (result.status === "success") setNotice(successMessage);
    }

    const methods: readonly MultiFactorAuthenticationMethod[] = summary.mfa.methods;
    return (
        <SecuritySection
            description="Confirm your identity before sensitive changes, or change your Dashboard password."
            id="security-verification-heading"
            title="Verification and password"
        >
            <Alert className="mb-4" message={action.error} />
            <Alert className="mb-4" message={notice} variant="success" />
            <dl className="mb-6 grid gap-3 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-primary-400">Password confirmed recently</dt>
                    <dd className="text-primary-100 font-medium">
                        {summary.recentAuth.password.recent ? "Yes" : "Needed"}
                    </dd>
                </div>
                <div>
                    <dt className="text-primary-400">MFA confirmed recently</dt>
                    <dd className="text-primary-100 font-medium">
                        {summary.recentAuth.mfa.recent ? "Yes" : "Needed"}
                    </dd>
                </div>
            </dl>
            <SecurityProofControls
                action={action}
                complete={complete}
                methods={methods}
            />
            <PasswordChangeForm action={action} complete={complete} />
        </SecuritySection>
    );
}
