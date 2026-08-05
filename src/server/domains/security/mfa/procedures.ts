import { router } from "../../../trpc/trpc.ts";
import { accountFactorRoutes } from "./accountFactorRoutes.ts";
import { accountMaintenanceRoutes } from "./accountMaintenanceRoutes.ts";
import { accountProofRoutes } from "./accountProofRoutes.ts";

/** Account-security router composed from focused route records. */
export const accountSecurityRouter = router({
    ...accountFactorRoutes,
    ...accountProofRoutes,
    ...accountMaintenanceRoutes,
});
