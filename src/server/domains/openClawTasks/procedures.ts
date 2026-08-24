import { router } from "../../trpc/trpc.ts";
import { openClawTaskRoutes } from "./routes.ts";

export const openClawTaskProcedureNames = Object.freeze(Object.keys(openClawTaskRoutes));

export const openClawTasksRouter = router(openClawTaskRoutes);
