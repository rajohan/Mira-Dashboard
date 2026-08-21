import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { WorkspaceFilesRoute } from "../files/WorkspaceFilesRoute.tsx";

export const Route = createLazyRoute("/files")({
    component: function WorkspaceFilesRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <WorkspaceFilesRoute />
            </AuthenticationBoundary>
        );
    },
});
