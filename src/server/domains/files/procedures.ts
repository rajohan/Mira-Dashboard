import { router } from "../../trpc/trpc.ts";
import { workspaceFileRoutes } from "./routes.ts";

export const workspaceFileProcedureNames = Object.freeze(
    Object.keys(workspaceFileRoutes)
);
export const workspaceFilesRouter = router(workspaceFileRoutes);
