import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { DatabaseRoute } from "../database/DatabaseRoute.tsx";

export const Route = createLazyRoute("/database")({
    component: function DatabaseRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <DatabaseRoute />
            </AuthenticationBoundary>
        );
    },
});
