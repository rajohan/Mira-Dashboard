import {
    createOwnedDatabaseLayer,
    type DatabaseRuntimeOwner,
} from "./databaseRuntimeOwner.ts";
import {
    databaseCandidateMigrationLayer,
    type DatabaseCandidateMigrationLayerOptions,
} from "./databaseService.ts";

export type { DatabaseRuntimeOwner } from "./databaseRuntimeOwner.ts";

/**
 * Creates a delivery-only owner that advances an isolated database copy.
 * Normal web and worker composition cannot select this migration strategy.
 * @param candidate Exact private candidate state and immutable release inputs.
 * @returns Candidate migration lifecycle owner.
 */
export function createDatabaseCandidateMigrationOwner(
    candidate: DatabaseCandidateMigrationLayerOptions
): DatabaseRuntimeOwner {
    return createOwnedDatabaseLayer(databaseCandidateMigrationLayer(candidate));
}
