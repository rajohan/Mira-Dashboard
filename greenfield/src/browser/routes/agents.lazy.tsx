import { createLazyRoute } from "@tanstack/react-router";

import { AgentsRoute } from "../agents/AgentsRoute.tsx";
import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";

export const Route = createLazyRoute("/agents")({
    component: function AgentsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <AgentsRoute />
            </AuthenticationBoundary>
        );
    },
});
