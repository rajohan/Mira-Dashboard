import { useQuery } from "@tanstack/react-query";
import { Navigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { PageState } from "../ui/PageState.tsx";
import { authStatusQueryOptions } from "./authQueries.ts";
import { BootstrapForm } from "./BootstrapForm.tsx";
import { EmailVerificationForm } from "./EmailVerificationForm.tsx";
import { parseLoginRouteSearch } from "./loginRouteSearch.ts";
import { PasswordLoginForm } from "./PasswordLoginForm.tsx";
import { PasswordRecoveryForm } from "./PasswordRecoveryForm.tsx";
import { PendingMfaForm } from "./PendingMfaForm.tsx";

/**
 * Routes bootstrap, password, and pending-MFA authentication states.
 * @returns The current login step or an authenticated redirect.
 */
export function LoginRoute() {
    const { resetToken, verifyEmailToken } = parseLoginRouteSearch(
        useSearch({ from: "/login" }) as unknown
    );
    const [recovering, setRecovering] = useState(resetToken !== undefined);
    const [resetLinkActive, setResetLinkActive] = useState(resetToken !== undefined);
    const client = useDashboardTrpcClient();
    const status = useQuery({
        ...authStatusQueryOptions(client),
        refetchOnMount: false,
    });

    if (verifyEmailToken !== undefined) {
        if (status.isPending) {
            return <PageState label="Loading sign-in…" status="loading" />;
        }
        return (
            <EmailVerificationForm
                onBack={() => globalThis.location.assign("/login")}
                token={verifyEmailToken}
            />
        );
    }
    if (resetToken !== undefined && resetLinkActive) {
        return (
            <PasswordRecoveryForm
                onBack={() => {
                    setResetLinkActive(false);
                    setRecovering(false);
                }}
                token={resetToken}
            />
        );
    }
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
            return recovering ? (
                <PasswordRecoveryForm
                    onBack={() => setRecovering(false)}
                    {...(resetToken === undefined ? {} : { token: resetToken })}
                />
            ) : (
                <PasswordLoginForm onForgotPassword={() => setRecovering(true)} />
            );
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
