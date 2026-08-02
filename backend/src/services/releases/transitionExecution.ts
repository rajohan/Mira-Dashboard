import {
    RELEASE_TRANSITION_JOURNAL_FILE_NAME,
    type DashboardReleaseLayout,
    type DashboardReleaseState,
    type ReleaseTransitionJournal,
} from "./managerModel.ts";
import {
    assertDashboardReleaseStateMatches,
    readDashboardReleaseStateFromLayout,
    restoreInterruptedReleaseTransition,
} from "./releaseLayout.ts";
import {
    removeReleaseTransitionControlFile,
    writeReleaseTransitionJournal,
} from "./transitionJournal.ts";

/**
 * Applies one journaled release transition and restores the previous links if
 * either the transition or its verification fails.
 * @param layout Managed release layout.
 * @param journal Transition journal describing the expected link state.
 * @param apply Transition operation.
 * @returns Verified release state after the transition.
 */
export async function executeReleaseTransition(
    layout: DashboardReleaseLayout,
    journal: ReleaseTransitionJournal,
    apply: () => Promise<void>
): Promise<DashboardReleaseState> {
    const snapshot = await writeReleaseTransitionJournal(layout, journal);
    try {
        await apply();
        const state = await readDashboardReleaseStateFromLayout(layout);
        assertDashboardReleaseStateMatches(state, journal.after);
        await removeReleaseTransitionControlFile(
            layout,
            RELEASE_TRANSITION_JOURNAL_FILE_NAME,
            snapshot
        );
        return state;
    } catch (error) {
        try {
            await restoreInterruptedReleaseTransition(layout, snapshot);
        } catch (recoveryError) {
            const transitionFailure = new AggregateError(
                [error, recoveryError],
                "Managed release transition and recovery both failed",
                { cause: error }
            );
            throw transitionFailure;
        }
        throw error;
    }
}
