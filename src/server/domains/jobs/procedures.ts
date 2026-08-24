import { router } from "../../trpc/trpc.ts";
import { jobRoutes, scheduleRoutes } from "./routes.ts";

/** Leaf procedure names owned by the durable-job router. */
export const jobProcedureNames = Object.freeze(Object.keys(jobRoutes));

/** Durable run inventory, cancellation, and worker-control router. */
export const jobRouter = router(jobRoutes);

/** Leaf procedure names owned by the Dashboard-local schedule router. */
export const scheduleProcedureNames = Object.freeze(Object.keys(scheduleRoutes));

/** Dashboard-local schedule inventory, update, and run router. */
export const scheduleRouter = router(scheduleRoutes);
