import { router } from "../../trpc/trpc.ts";
import { openClawCronRoutes } from "./routes.ts";

/** Leaf procedure names owned by the Gateway-backed OpenClaw cron router. */
export const openClawCronProcedureNames = Object.freeze(Object.keys(openClawCronRoutes));

/** Session-only OpenClaw cron inventory and recent-MFA controls. */
export const openClawCronRouter = router(openClawCronRoutes);
