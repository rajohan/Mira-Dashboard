import { taskCrudRoutes } from "./taskCrudRoutes.ts";
import { taskUpdateRoutes } from "./taskUpdateRoutes.ts";
import { taskWorkflowRoutes } from "./taskWorkflowRoutes.ts";

export const taskRoutes = {
    ...taskCrudRoutes,
    ...taskWorkflowRoutes,
    ...taskUpdateRoutes,
} as const;
