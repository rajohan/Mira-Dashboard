import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { DocsRoute } from "../docs/DocsRoute.tsx";

export const Route = createLazyRoute("/docs")({
    component: function DocsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <DocsRoute />
            </AuthenticationBoundary>
        );
    },
});
