import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { AuthenticatedDocsRoute } from "../docs/AuthenticatedDocsRoute.tsx";

export const Route = createLazyRoute("/docs")({
    component: function DocsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <AuthenticatedDocsRoute />
            </AuthenticationBoundary>
        );
    },
});
