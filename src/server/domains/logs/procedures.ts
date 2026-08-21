import { router } from "../../trpc/trpc.ts";
import { logRoutes } from "./routes.ts";

export const logProcedureNames = Object.freeze(Object.keys(logRoutes));
export const logsRouter = router(logRoutes);
