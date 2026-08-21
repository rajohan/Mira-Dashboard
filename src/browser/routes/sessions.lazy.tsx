import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { GatewaySessionsRoute } from "../sessions/GatewaySessionsRoute.tsx";

export const Route = createLazyRoute("/sessions")({
    component: function GatewaySessionsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <GatewaySessionsRoute />
            </AuthenticationBoundary>
        );
    },
});
