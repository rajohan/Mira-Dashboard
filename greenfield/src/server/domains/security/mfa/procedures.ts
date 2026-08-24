import { router } from "../../../trpc/trpc.ts";
import { accountFactorRoutes } from "./accountFactorRoutes.ts";
import { accountMaintenanceRoutes } from "./accountMaintenanceRoutes.ts";
import { accountProofRoutes } from "./accountProofRoutes.ts";
import { accountWebAuthnRoutes } from "./accountWebAuthnRoutes.ts";

const accountSecurityRoutes = {
    ...accountFactorRoutes,
    ...accountProofRoutes,
    ...accountMaintenanceRoutes,
    ...accountWebAuthnRoutes,
};

/** Leaf procedure names owned by the account-security-router composition. */
export const accountSecurityProcedureNames = Object.freeze(
    Object.keys(accountSecurityRoutes)
);

/** Account-security router composed from focused route records. */
export const accountSecurityRouter = router(accountSecurityRoutes);
