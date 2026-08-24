import { router } from "../../trpc/trpc.ts";
import { authPendingMfaRoutes } from "./authPendingMfaRoutes.ts";
import { authPublicRoutes } from "./authPublicRoutes.ts";
import { authSessionRoutes } from "./authSessionRoutes.ts";

const authRoutes = {
    ...authPublicRoutes,
    ...authPendingMfaRoutes,
    ...authSessionRoutes,
};

/** Leaf procedure names owned by the authentication-router composition. */
export const authProcedureNames = Object.freeze(Object.keys(authRoutes));

/** Browser authentication router composed from focused route records. */
export const authRouter = router(authRoutes);
