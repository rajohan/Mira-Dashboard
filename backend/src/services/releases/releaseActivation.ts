import { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "../../database/schemaCompatibility.ts";
import {
    RELEASE_TRANSITION_FORMAT_VERSION,
    type DashboardReleaseManagerOptions,
    type DashboardReleaseState,
    type ManagedDashboardRelease,
    type ReleaseTransitionJournal,
} from "./managerModel.ts";
import {
    applyReleaseLinkState,
    ensureDashboardReleaseLayout,
    loadManagedReleaseFromLayout,
    readActivationReleaseStateFromLayout,
    readDashboardReleaseStateFromLayout,
    recoverInterruptedReleaseTransition,
    releaseLinkStateFromDashboardState,
    resolveDashboardReleasesRoot,
} from "./releaseLayout.ts";
import {
    assertDashboardReleaseRuntimeAvailable,
    assertReleaseActivationCompatible,
    assertReleaseCanActivateLiveSchema,
    assertReleaseMigrationHistoryCompatible,
    resolveLiveSchemaState,
} from "./schemaCompatibility.ts";
import { executeReleaseTransition } from "./transitionExecution.ts";
import { readReleaseTransitionJournal } from "./transitionJournal.ts";
import {
    withPreparedReleaseTransition,
    withReleaseTransitionLock,
} from "./transitionLock.ts";

/**
 * Reads the managed current and previous release slots under a shared lock.
 * @param releasesRoot Managed releases root.
 * @param options Shared-lock options.
 * @returns Managed release state.
 */
export async function readDashboardReleaseState(
    releasesRoot = resolveDashboardReleasesRoot(),
    options: Pick<DashboardReleaseManagerOptions, "transitionLockWaitMs"> = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "shared",
        async () => {
            if (await readReleaseTransitionJournal(layout)) {
                throw new Error(
                    "Managed release status requires activate, restore, or rollback to recover an interrupted transition"
                );
            }
            return readDashboardReleaseStateFromLayout(layout);
        },
        options.transitionLockWaitMs
    );
}

/**
 * Makes a verified managed release current after checking runtime and schema
 * compatibility.
 * @param commitSha Commit to activate.
 * @param releasesRoot Managed releases root.
 * @param options Release transition options.
 * @returns Verified release state after activation.
 */
export async function activateDashboardRelease(
    commitSha: string,
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseManagerOptions = {}
): Promise<DashboardReleaseState> {
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            const candidate = await loadManagedReleaseFromLayout(layout, commitSha);
            assertDashboardReleaseRuntimeAvailable(candidate, options);
            const state = await readActivationReleaseStateFromLayout(layout);
            if (state.current) {
                assertReleaseActivationCompatible(
                    candidate.manifest,
                    state.current.manifest,
                    options.schemaCutoverMode
                );
            } else if (options.schemaCutoverMode === "coordinated") {
                throw new Error(
                    "Coordinated schema cutover mode requires an active current release"
                );
            }
            const maximumInspectableSchemaVersion = Math.max(
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
                candidate.manifest.schema.maximumCompatible,
                state.current?.manifest.schema.maximumCompatible ?? 0
            );
            const liveSchemaState = await resolveLiveSchemaState(
                options,
                maximumInspectableSchemaVersion
            );
            assertReleaseCanActivateLiveSchema(
                candidate.manifest,
                liveSchemaState.version,
                options.schemaCutoverMode
            );
            assertReleaseMigrationHistoryCompatible(
                candidate.manifest,
                liveSchemaState,
                "Activation"
            );
            return withPreparedReleaseTransition(candidate, options, async () => {
                if (state.current?.commitSha === candidate.commitSha) {
                    return state;
                }

                const before = releaseLinkStateFromDashboardState(state);
                const journal: ReleaseTransitionJournal = {
                    after: {
                        current: candidate.commitSha,
                        previous: before.current,
                    },
                    before,
                    formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                    operation: "activate",
                };
                return executeReleaseTransition(layout, journal, async () => {
                    const expectedReleases = new Map<string, ManagedDashboardRelease>([
                        [candidate.commitSha, candidate],
                    ]);
                    if (state.current) {
                        expectedReleases.set(state.current.commitSha, state.current);
                    }
                    await applyReleaseLinkState(layout, journal.after, expectedReleases);
                });
            });
        },
        options.transitionLockWaitMs
    );
}
