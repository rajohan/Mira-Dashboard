import { router } from "../../trpc/trpc.ts";
import { terminalRoutes } from "./routes.ts";

/** Leaf procedure names owned by the interactive terminal router. */
export const terminalProcedureNames = Object.freeze(Object.keys(terminalRoutes));

/** Session-only interactive PTY lifecycle router. */
export const terminalRouter = router(terminalRoutes);
