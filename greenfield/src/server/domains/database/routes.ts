import { databaseOverviewContract } from "../../../contracts/database.ts";
import { sessionCapabilityProcedure } from "../../trpc/trpc.ts";

const readProcedure = sessionCapabilityProcedure("database:read");

/** Session-only, read-only SQLite and PostgreSQL/PgBouncer observability query. */
export const databaseRoutes = {
    overview: readProcedure
        .input(databaseOverviewContract.input)
        .output(databaseOverviewContract.output)
        .query(({ ctx }) => ctx.databaseObservabilityService.read()),
};
