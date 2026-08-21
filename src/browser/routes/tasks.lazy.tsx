import { createLazyRoute } from "@tanstack/react-router";

import { AuthenticationBoundary } from "../auth/AuthenticationBoundary.tsx";
import { TaskBoardRoute } from "../tasks/TaskBoardRoute.tsx";

export const Route = createLazyRoute("/tasks")({
    component: function TasksRouteBoundary() {
        return (
            <AuthenticationBoundary>
                <TaskBoardRoute />
            </AuthenticationBoundary>
        );
    },
});
