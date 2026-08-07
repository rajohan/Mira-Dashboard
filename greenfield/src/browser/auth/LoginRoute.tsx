import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { PageState } from "../ui/PageState.tsx";
import { authStatusQueryOptions } from "./authQueries.ts";
import { BootstrapForm } from "./BootstrapForm.tsx";
import { PasswordLoginForm } from "./PasswordLoginForm.tsx";
import { PendingMfaForm } from "./PendingMfaForm.tsx";

/**
 * Routes bootstrap, password, and pending-MFA authentication states.
 * @returns The current login step or an authenticated redirect.
 */
export function LoginRoute() {
    const client = useDashboardTrpcClient();
    const status = useQuery({
        ...authStatusQueryOptions(client),
        refetchOnMount: false,
    });

    if (status.isPending) {
        return <PageState label="Loading sign-in…" status="loading" />;
    }
    if (status.isError) {
        return (
            <PageState
                message={dashboardBrowserFailureMessage(status.error)}
                onRetry={() => void status.refetch()}
                retryBusy={status.isFetching}
                status="error"
                title="Sign-in unavailable"
            />
        );
    }
    switch (status.data.state) {
        case "anonymous": {
            return <PasswordLoginForm />;
        }
        case "authenticated": {
            return <Navigate replace to="/" />;
        }
        case "bootstrap-required": {
            return <BootstrapForm />;
        }
        case "pending-mfa": {
            return <PendingMfaForm status={status.data} />;
        }
    }
}
