import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { LogsRoute } from "../logs/LogsRoute.tsx";

export const Route = createLazyRoute("/logs")({
    component: function LogsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <LogsRoute />
            </AuthenticationBoundary>
        );
    },
});
