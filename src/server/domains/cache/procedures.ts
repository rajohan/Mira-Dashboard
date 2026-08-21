import { router } from "../../trpc/trpc.ts";
import { cacheRoutes } from "./routes.ts";

/** Leaf procedure names owned by the cache router. */
export const cacheProcedureNames = Object.freeze(Object.keys(cacheRoutes));

/** Cache projection lookup, status, and manual-refresh router. */
export const cacheRouter = router(cacheRoutes);
