import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { IncidentsRoute } from "../monitoring/IncidentsRoute.tsx";

export const Route = createLazyRoute("/incidents")({
    component: function IncidentsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <IncidentsRoute />
            </AuthenticationBoundary>
        );
    },
});
