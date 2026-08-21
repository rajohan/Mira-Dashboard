import { router } from "../../trpc/trpc.ts";
import { taskRoutes } from "./routes.ts";

/** Leaf procedure names owned by the task-domain router. */
export const taskProcedureNames = Object.freeze(Object.keys(taskRoutes));

/** Capability-scoped task board and progress router. */
export const taskRouter = router(taskRoutes);
