import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { OverviewRoute } from "../overview/OverviewRoute.tsx";

export const Route = createLazyRoute("/")({
    component: function OverviewRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <OverviewRoute />
            </AuthenticationBoundary>
        );
    },
});
