import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { TerminalRoute } from "../terminal/TerminalRoute.tsx";

export const Route = createLazyRoute("/terminal")({
    component: function TerminalRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <TerminalRoute />
            </AuthenticationBoundary>
        );
    },
});
