import { router } from "../../trpc/trpc.ts";
import { gatewayConnectionRoutes } from "./routes.ts";

/** Nested leaf names owned by the native Gateway router. */
export const gatewayProcedureNames = Object.freeze(
    Object.keys(gatewayConnectionRoutes).map((name) => `connection.${name}`)
);

/** Session-only native Gateway projections grouped below `gateway`. */
export const gatewayRouter = router({ connection: router(gatewayConnectionRoutes) });
