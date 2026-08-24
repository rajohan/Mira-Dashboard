import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { SettingsRoute } from "../settings/SettingsRoute.tsx";

export const Route = createLazyRoute("/settings")({
    component: function SettingsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <SettingsRoute />
            </AuthenticationBoundary>
        );
    },
});
