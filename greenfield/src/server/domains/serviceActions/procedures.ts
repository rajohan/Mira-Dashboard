import { router } from "../../trpc/trpc.ts";
import { serviceActionsRoutes } from "./routes.ts";

/** Leaf procedure names owned by the fixed Service Actions router. */
export const serviceActionsProcedureNames = Object.freeze(
    Object.keys(serviceActionsRoutes)
);

/** Session-only status and recent-MFA fixed-operation queue controls. */
export const serviceActionsRouter = router(serviceActionsRoutes);
