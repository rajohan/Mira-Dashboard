import { router } from "../../trpc/trpc.ts";
import { agentRoutes } from "./routes.ts";

/** Leaf procedure names owned by the agent-domain router. */
export const agentProcedureNames = Object.freeze(Object.keys(agentRoutes));

/** Capability-scoped Dashboard agent configuration and current-task router. */
export const agentRouter = router(agentRoutes);
