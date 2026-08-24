import { router } from "../../trpc/trpc.ts";
import { gatewaySessionRoutes } from "./routes.ts";

/** Leaf procedure names owned by the current OpenClaw session router. */
export const gatewaySessionProcedureNames = Object.freeze(
    Object.keys(gatewaySessionRoutes)
);

/** Session-only current OpenClaw session inventory and recent-MFA controls. */
export const gatewaySessionsRouter = router(gatewaySessionRoutes);
