import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { ReportsRoute } from "../monitoring/ReportsRoute.tsx";

export const Route = createLazyRoute("/reports")({
    component: function ReportsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <ReportsRoute />
            </AuthenticationBoundary>
        );
    },
});
