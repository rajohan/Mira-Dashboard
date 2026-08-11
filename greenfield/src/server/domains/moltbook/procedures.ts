import { router } from "../../trpc/trpc.ts";
import { moltbookRoutes } from "./routes.ts";

/** Leaf procedure names owned by the Moltbook router. */
export const moltbookProcedureNames = Object.freeze(Object.keys(moltbookRoutes));

/** Read-only Moltbook snapshot router. */
export const moltbookRouter = router(moltbookRoutes);
