import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { AccountSecurityRoute } from "../security/AccountSecurityRoute.tsx";

export const Route = createLazyRoute("/account-security")({
    component: function AccountSecurityBoundary() {
        return (
            <AuthenticationBoundary>
                <AccountSecurityRoute />
            </AuthenticationBoundary>
        );
    },
});
