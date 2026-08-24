import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { ChatRoute } from "../chat/ChatRoute.tsx";

export const Route = createLazyRoute("/chat")({
    component: function ChatRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <ChatRoute />
            </AuthenticationBoundary>
        );
    },
});
