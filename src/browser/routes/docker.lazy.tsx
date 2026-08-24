import { createLazyRoute } from "@tanstack/react-router";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { dockerClient, DockerRoute } from "../docker/index.ts";

export const Route = createLazyRoute("/docker")({
    component: function DockerRouteBoundary() {
        const client = useDashboardTrpcClient();
        return (
            <AuthenticationBoundary>
                <DockerRoute client={dockerClient(client)} />
            </AuthenticationBoundary>
        );
    },
});
