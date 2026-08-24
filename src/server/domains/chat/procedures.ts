import { router } from "../../trpc/trpc.ts";
import { chatRoutes } from "./routes.ts";

export const chatProcedureNames = Object.freeze(Object.keys(chatRoutes));
export const chatRouter = router(chatRoutes);
