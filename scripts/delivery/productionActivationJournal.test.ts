import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductionActivationTransition } from "../../src/shared/productionActivationTransition.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    clearProductionActivationJournal,
    createProductionActivationJournal,
    loadProductionActivationJournal,
    markProductionDatabasePromoted,
    markProductionRollbackRequired,
    markProductionSnapshotPrepared,
} from "./productionActivationJournal.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];

async function restoreOwnerWrite(directory: string): Promise<void> {
    const status = await stat(directory).catch(() => null);
    if (!status?.isDirectory()) return;
    await chmod(directory, 0o700);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(entryPath);
        } else if (entry.isFile()) {
            await chmod(entryPath, 0o600);
        }
    }
}

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function fixture() {
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-activation-journal-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return { paths, state };
}

function stopRequestedTransition(transitionId: string): ProductionActivationTransition {
    return {
        candidate: {
            releaseId: "a".repeat(40),
            runtimeRevision: "b".repeat(40),
        },
        formatVersion: 1,
        phase: "service-stop-requested",
        previousActivation: null,
        previousDatabase: { state: "unrecorded" },
        transitionId,
    };
}

describe("production activation journal", () => {
    test("durably advances service stop through rollback and clears exactly", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            expect(await loadProductionActivationJournal(lease, paths)).toBeUndefined();
            const requested = await createProductionActivationJournal(
                lease,
                paths,
                stopRequestedTransition(Bun.randomUUIDv7())
            );
            const loadedRequested = await loadProductionActivationJournal(lease, paths);
            expect(loadedRequested?.phase).toBe("service-stop-requested");
            const prepared = await markProductionSnapshotPrepared(
                lease,
                paths,
                requested,
                { state: "absent" }
            );
            const loadedPrepared = await loadProductionActivationJournal(lease, paths);
            expect(loadedPrepared?.phase).toBe("prepared");
            const promoted = await markProductionDatabasePromoted(lease, paths, prepared);
            expect(promoted.phase).toBe("database-promoted");
            const staleStage = path.join(
                paths.stateDirectory,
                `.activation-transition-${promoted.transitionId}.json`
            );
            await writeFile(staleStage, "partial", { mode: 0o600 });
            const rollback = await markProductionRollbackRequired(lease, paths, promoted);
            expect(rollback.phase).toBe("rollback-required");
            expect(await stat(staleStage).catch(() => null)).toBeNull();
            await clearProductionActivationJournal(lease, paths, rollback);
            expect(await loadProductionActivationJournal(lease, paths)).toBeUndefined();
        });
    });

    test("rejects competing creation and stale phase updates", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const first = await createProductionActivationJournal(
                lease,
                paths,
                stopRequestedTransition(Bun.randomUUIDv7())
            );
            const competingFailure = await rejectionError(
                createProductionActivationJournal(
                    lease,
                    paths,
                    stopRequestedTransition(Bun.randomUUIDv7())
                )
            );
            expect(competingFailure.message).toBe(
                "Production activation journal update failed"
            );
            const prepared = await markProductionSnapshotPrepared(lease, paths, first, {
                state: "absent",
            });
            const promoted = await markProductionDatabasePromoted(lease, paths, prepared);
            const staleFailure = await rejectionError(
                markProductionDatabasePromoted(lease, paths, prepared)
            );
            expect(staleFailure.message).toBe(
                "Production activation journal update failed"
            );
            const rollback = await markProductionRollbackRequired(lease, paths, promoted);
            const staleRollbackFailure = await rejectionError(
                markProductionRollbackRequired(lease, paths, promoted)
            );
            expect(staleRollbackFailure.message).toBe(
                "Production activation journal update failed"
            );
            await clearProductionActivationJournal(lease, paths, rollback);
        });
    });

    test("preserves an invalid stale stage and fails closed", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const requested = await createProductionActivationJournal(
                lease,
                paths,
                stopRequestedTransition(Bun.randomUUIDv7())
            );
            const staleStage = path.join(
                paths.stateDirectory,
                `.activation-transition-${requested.transitionId}.json`
            );
            await writeFile(staleStage, "partial", { mode: 0o600 });
            await chmod(staleStage, 0o640);

            const failure = await rejectionError(
                markProductionSnapshotPrepared(lease, paths, requested, {
                    state: "absent",
                })
            );

            expect(failure.message).toBe("Production activation journal update failed");
            const staleStatus = await stat(staleStage);
            const journal = await loadProductionActivationJournal(lease, paths);
            expect(staleStatus.mode & 0o777).toBe(0o640);
            expect(journal?.phase).toBe("service-stop-requested");
        });
    });

    test("fails closed when an opened journal entry disappears after reading", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            await createProductionActivationJournal(
                lease,
                paths,
                stopRequestedTransition(Bun.randomUUIDv7())
            );
            const failure = await rejectionError(
                loadProductionActivationJournal(lease, paths, {
                    afterRead: () =>
                        unlink(
                            path.join(paths.stateDirectory, "activation-transition.json")
                        ),
                })
            );
            expect(failure.message).toBe("Production activation journal update failed");
        });
    });
});
