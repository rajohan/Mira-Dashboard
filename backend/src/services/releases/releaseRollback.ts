import {
    assertReleaseCommitSha,
    RELEASE_TRANSITION_FORMAT_VERSION,
    type DashboardReleaseFailedActivationRestoreOptions,
    type DashboardReleaseRollbackOptions,
    type DashboardReleaseState,
    type ManagedDashboardRelease,
    type ReleaseTransitionJournal,
} from "./managerModel.ts";
import {
    applyReleaseLinkState,
    ensureDashboardReleaseLayout,
    loadManagedReleaseFromLayout,
    readDashboardReleaseStateFromLayout,
    recoverInterruptedReleaseTransition,
    releaseLinkStateFromDashboardState,
    replaceReleaseLink,
    resolveDashboardReleasesRoot,
} from "./releaseLayout.ts";
import {
    assertDashboardReleaseRuntimeAvailable,
    assertManagedDashboardReleaseRollbackSchemaCompatible,
} from "./schemaCompatibility.ts";
import { executeReleaseTransition } from "./transitionExecution.ts";
import {
    withPreparedReleaseTransition,
    withReleaseTransitionLock,
} from "./transitionLock.ts";

/**
 * Swaps the current and previous release slots after validating the guarded
 * expectation, runtime, and schema compatibility.
 * @param releasesRoot Managed releases root.
 * @param options Rollback options.
 * @returns Verified release state after rollback.
 */
export async function rollbackDashboardRelease(
    releasesRoot = resolveDashboardReleasesRoot(),
    options: DashboardReleaseRollbackOptions = {}
): Promise<DashboardReleaseState> {
    const expectation = options.expected;
    if (expectation) {
        assertReleaseCommitSha(expectation.currentCommitSha);
        assertReleaseCommitSha(expectation.targetCommitSha);
        if (expectation.currentCommitSha === expectation.targetCommitSha) {
            throw new TypeError(
                "Managed release rollback expectation requires distinct releases"
            );
        }
    }
    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            const state = await readDashboardReleaseStateFromLayout(layout);
            if (!state.current || !state.previous) {
                throw new Error("Managed release rollback requires current and previous");
            }
            if (state.current.commitSha === state.previous.commitSha) {
                throw new Error(
                    "Managed release rollback requires two distinct releases"
                );
            }
            if (
                expectation &&
                (state.current.commitSha !== expectation.currentCommitSha ||
                    state.previous.commitSha !== expectation.targetCommitSha)
            ) {
                throw new Error(
                    "Managed release rollback slots changed before the guarded transition"
                );
            }

            const activeRelease = state.current;
            const rollbackRelease = state.previous;
            assertDashboardReleaseRuntimeAvailable(rollbackRelease, options);
            await assertManagedDashboardReleaseRollbackSchemaCompatible(
                activeRelease,
                rollbackRelease,
                options
            );

            const before = releaseLinkStateFromDashboardState(state);
            const journal: ReleaseTransitionJournal = {
                after: {
                    current: rollbackRelease.commitSha,
                    previous: activeRelease.commitSha,
                },
                before,
                formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                operation: "rollback",
            };
            return withPreparedReleaseTransition(rollbackRelease, options, async () =>
                executeReleaseTransition(layout, journal, async () => {
                    await replaceReleaseLink(
                        layout,
                        "current",
                        rollbackRelease.commitSha,
                        rollbackRelease
                    );
                    await replaceReleaseLink(
                        layout,
                        "previous",
                        activeRelease.commitSha,
                        activeRelease
                    );
                })
            );
        },
        options.transitionLockWaitMs
    );
}

/**
 * Restores the exact current/previous snapshot that existed before a failed
 * activation. Unlike a manual rollback, the failed candidate is not retained
 * in the previous slot.
 * @param options Failed activation restore options.
 * @param releasesRoot Managed releases root.
 * @returns Verified release state after restoration.
 */
export async function restoreDashboardReleaseAfterFailedActivation(
    options: DashboardReleaseFailedActivationRestoreOptions,
    releasesRoot = resolveDashboardReleasesRoot()
): Promise<DashboardReleaseState> {
    const { candidateCommitSha, previousCommitSha, rollbackCommitSha } = options.expected;
    assertReleaseCommitSha(candidateCommitSha);
    assertReleaseCommitSha(rollbackCommitSha);
    if (previousCommitSha) {
        assertReleaseCommitSha(previousCommitSha);
    }
    if (
        candidateCommitSha === rollbackCommitSha ||
        rollbackCommitSha === previousCommitSha
    ) {
        throw new TypeError(
            "Failed activation restore requires distinct managed releases"
        );
    }

    const layout = await ensureDashboardReleaseLayout(releasesRoot);
    return withReleaseTransitionLock(
        layout,
        "exclusive",
        async () => {
            await recoverInterruptedReleaseTransition(layout);
            const state = await readDashboardReleaseStateFromLayout(layout);
            if (
                state.current?.commitSha === rollbackCommitSha &&
                state.previous?.commitSha === previousCommitSha
            ) {
                assertDashboardReleaseRuntimeAvailable(state.current, options);
                await assertManagedDashboardReleaseRollbackSchemaCompatible(
                    state.current,
                    state.current,
                    options
                );
                return withPreparedReleaseTransition(state.current, options, () =>
                    Promise.resolve(state)
                );
            }
            if (
                state.current?.commitSha !== candidateCommitSha ||
                state.previous?.commitSha !== rollbackCommitSha
            ) {
                throw new Error(
                    "Managed release slots changed before the failed activation restore"
                );
            }

            const candidateRelease = state.current;
            const rollbackRelease = state.previous;
            assertDashboardReleaseRuntimeAvailable(rollbackRelease, options);
            const restoredPreviousRelease = previousCommitSha
                ? await loadManagedReleaseFromLayout(layout, previousCommitSha)
                : undefined;
            await assertManagedDashboardReleaseRollbackSchemaCompatible(
                candidateRelease,
                rollbackRelease,
                options
            );

            const before = releaseLinkStateFromDashboardState(state);
            const journal: ReleaseTransitionJournal = {
                after: {
                    current: rollbackCommitSha,
                    previous: previousCommitSha ?? false,
                },
                before,
                formatVersion: RELEASE_TRANSITION_FORMAT_VERSION,
                operation: "restore",
            };
            return withPreparedReleaseTransition(rollbackRelease, options, () =>
                executeReleaseTransition(layout, journal, async () => {
                    const expectedReleases = new Map<string, ManagedDashboardRelease>([
                        [candidateCommitSha, candidateRelease],
                        [rollbackCommitSha, rollbackRelease],
                    ]);
                    if (restoredPreviousRelease) {
                        expectedReleases.set(
                            restoredPreviousRelease.commitSha,
                            restoredPreviousRelease
                        );
                    }
                    await applyReleaseLinkState(layout, journal.after, expectedReleases);
                })
            );
        },
        options.transitionLockWaitMs
    );
}
