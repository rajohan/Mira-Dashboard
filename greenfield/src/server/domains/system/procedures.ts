import { runtimeIdentityContract } from "../../../contracts/system.ts";
import { readRuntimeIdentity } from "../../platform/runtime/readRuntimeIdentity.ts";
import { publicProcedure, router } from "../../trpc/trpc.ts";

const systemRoutes = {
    runtimeIdentity: publicProcedure
        .input(runtimeIdentityContract.input)
        .output(runtimeIdentityContract.output)
        .query(() => readRuntimeIdentity()),
};

/** Leaf procedure names owned by the system-router composition. */
export const systemProcedureNames = Object.freeze(Object.keys(systemRoutes));

/** Public system procedures implemented by the foundation slice. */
export const systemRouter = router(systemRoutes);
