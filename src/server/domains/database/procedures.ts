import { router } from "../../trpc/trpc.ts";
import { databaseRoutes } from "./routes.ts";

/** Leaf procedure names owned by the database observability router. */
export const databaseProcedureNames = Object.freeze(Object.keys(databaseRoutes));

/** Session-only, read-only database observability router. */
export const databaseRouter = router(databaseRoutes);
