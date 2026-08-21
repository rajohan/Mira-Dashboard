import { router } from "../../../trpc/trpc.ts";
import { automationSecurityRoutes } from "./routes.ts";

/** Leaf procedure names owned by the automation-security router composition. */
export const automationSecurityProcedureNames = Object.freeze(
    Object.keys(automationSecurityRoutes)
);

/** Browser-session-only automation principal and credential administration router. */
export const automationSecurityRouter = router(automationSecurityRoutes);
