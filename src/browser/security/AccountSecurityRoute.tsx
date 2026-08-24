import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Heading } from "../ui/Heading.tsx";
import { PageState } from "../ui/PageState.tsx";
import { AutomationSecuritySection } from "./AutomationSecuritySection.tsx";
import { MfaDisableSection } from "./MfaDisableSection.tsx";
import { MfaManagementSection } from "./MfaManagementSection.tsx";
import { SecurityAuditSection } from "./SecurityAuditSection.tsx";
import { accountSecuritySummaryQueryOptions } from "./securityQueries.ts";
import {
    AccountEmailSection,
    DashboardPasswordSection,
    SecurityVerificationSection,
} from "./SecurityVerificationSection.tsx";
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
            <Heading className="sr-only" level={1}>
                Account security
            </Heading>
            <div className="grid gap-4">
                <SecurityVerificationSection summary={summary.data} />
                <MfaManagementSection summary={summary.data} />
                <DashboardPasswordSection />
                <AccountEmailSection />
                <SessionManagementSection />
                <MfaDisableSection summary={summary.data} />
                <AutomationSecuritySection />
                <SecurityAuditSection />
            </div>
        </div>
    );
}
