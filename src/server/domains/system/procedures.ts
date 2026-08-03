import { runtimeIdentityContract } from "../../../contracts/system.ts";
import { readRuntimeIdentity } from "../../platform/runtime/readRuntimeIdentity.ts";
import { publicProcedure, router } from "../../trpc/trpc.ts";

/** Public system procedures implemented by the foundation slice. */
export const systemRouter = router({
    runtimeIdentity: publicProcedure
        .input(runtimeIdentityContract.input)
        .output(runtimeIdentityContract.output)
        .query(() => readRuntimeIdentity()),
});
