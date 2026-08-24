import { router } from "../../trpc/trpc.ts";
import { authPendingMfaRoutes } from "./authPendingMfaRoutes.ts";
import { authPublicRoutes } from "./authPublicRoutes.ts";
import { authSessionRoutes } from "./authSessionRoutes.ts";

/** Browser authentication router composed from focused route records. */
export const authRouter = router({
    ...authPublicRoutes,
    ...authPendingMfaRoutes,
    ...authSessionRoutes,
});
