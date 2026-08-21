import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { MoltbookRoute } from "../moltbook/MoltbookRoute.tsx";

export const Route = createLazyRoute("/moltbook")({
    component: function MoltbookRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <MoltbookRoute />
            </AuthenticationBoundary>
        );
    },
});
