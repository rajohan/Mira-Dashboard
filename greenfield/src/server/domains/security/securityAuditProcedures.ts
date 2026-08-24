import { router } from "../../trpc/trpc.ts";
import { securityAuditRoutes } from "./securityAuditRoutes.ts";

/** Leaf procedure names owned by the security-audit router composition. */
export const securityAuditProcedureNames = Object.freeze(
    Object.keys(securityAuditRoutes)
);

/** Browser-session-only immutable security audit router. */
export const securityAuditRouter = router(securityAuditRoutes);
