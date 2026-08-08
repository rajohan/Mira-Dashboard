import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { JobsRoute } from "../jobs/JobsRoute.tsx";

export const Route = createLazyRoute("/jobs")({
    component: function JobsRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <JobsRoute />
            </AuthenticationBoundary>
        );
    },
});
