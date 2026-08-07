import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { PageHeader } from "../ui/PageHeader.tsx";
import { PageState } from "../ui/PageState.tsx";
import { AutomationSecuritySection } from "./AutomationSecuritySection.tsx";
import { MfaManagementSection } from "./MfaManagementSection.tsx";
import { SecurityAuditSection } from "./SecurityAuditSection.tsx";
import { accountSecuritySummaryQueryOptions } from "./securityQueries.ts";
import { SecurityVerificationSection } from "./SecurityVerificationSection.tsx";
import { SessionManagementSection } from "./SessionManagementSection.tsx";

/**
 * Composes the Phase 2 operator security surface from contract-backed sections.
 * @returns The protected account-security route.
 */
export function AccountSecurityRoute() {
    const client = useDashboardTrpcClient();
    const summary = useQuery(accountSecuritySummaryQueryOptions(client));

    if (summary.isPending) {
        return <PageState label="Loading account security…" status="loading" />;
    }
    if (summary.isError) {
        return (
            <PageState
                message={dashboardBrowserFailureMessage(summary.error)}
                onRetry={() => void summary.refetch()}
                retryBusy={summary.isFetching}
                status="error"
                title="Account security unavailable"
            />
        );
    }

    return (
        <div>
            <PageHeader
                description="Manage recent verification, possession factors, browser sessions, immutable audit history, and scoped automation credentials."
                eyebrow="Operator controls"
                title="Account security"
            />
            <div className="mt-8 grid gap-6">
                <SecurityVerificationSection summary={summary.data} />
                <MfaManagementSection summary={summary.data} />
                <SessionManagementSection />
                <AutomationSecuritySection />
                <SecurityAuditSection />
            </div>
        </div>
    );
}
