import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { retainProductionDatabaseSnapshots } from "./databaseSnapshotRetention.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    for (const directory of temporaryDirectories.splice(0)) {
        await restoreOwnerWrite(directory);
        await rm(directory, { force: true, recursive: true });
    }
});

async function restoreOwnerWrite(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    await chmod(directory, 0o700).catch(() => {});
    for (const entry of entries) {
        const candidate = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            await restoreOwnerWrite(candidate);
        } else if (entry.isFile()) {
            await chmod(candidate, 0o600).catch(() => {});
        }
    }
}

function uuidV7At(timestampMs: number, suffix: number): string {
    const timestamp = timestampMs.toString(16).padStart(12, "0");
    return `${timestamp.slice(0, 8)}-${timestamp.slice(8)}-7000-8000-${suffix.toString(16).padStart(12, "0")}`;
}

async function snapshotFixture(directory: string): Promise<void> {
    await mkdir(directory, { mode: 0o700 });
    for (const fileName of ["mira-dashboard.db", "snapshot-manifest.json"]) {
        const file = path.join(directory, fileName);
        await writeFile(file, "fixture", { mode: 0o600 });
        await chmod(file, 0o400);
    }
    await chmod(directory, 0o500);
}

describe("production database snapshot retention", () => {
    test("preserves activation and journal references while pruning stale excess", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const ids = Array.from({ length: 9 }, (_, index) =>
            uuidV7At(nowMs - (index + 1) * 24 * 60 * 60_000, index + 1)
        );
        for (const id of ids) {
            await snapshotFixture(path.join(state.backupsDirectory, id));
        }

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await retainProductionDatabaseSnapshots(lease, paths, {
                activationTransitionIds: [ids[7]!],
                journalTransitionId: ids[8],
                nowMs,
            });
        });

        const entries = await readdir(state.backupsDirectory);
        const retained = entries.toSorted();
        expect(retained).toContain(ids[7]!);
        expect(retained).toContain(ids[8]!);
        expect(retained).not.toContain(ids[6]!);
        expect(retained.length).toBeLessThanOrEqual(5);
    });

    test("fails closed before pruning when a future UUIDv7 snapshot is present", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 3 * 24 * 60 * 60_000, 1);
        const futureId = uuidV7At(nowMs + 60_000, 2);
        await snapshotFixture(path.join(state.backupsDirectory, staleId));
        await snapshotFixture(path.join(state.backupsDirectory, futureId));

        expect(
            withDeploymentLease(state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                await retainProductionDatabaseSnapshots(lease, paths, {
                    activationTransitionIds: [],
                    nowMs,
                });
            })
        ).rejects.toThrow("Database snapshot retention failed");

        expect(await readdir(state.backupsDirectory)).toEqual(
            expect.arrayContaining([futureId, staleId])
        );
    });

    test("does not remove a replacement swapped into the selected parent entry", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 3 * 24 * 60 * 60_000, 1);
        const staleDirectory = path.join(state.backupsDirectory, staleId);
        const movedDirectory = path.join(state.backupsDirectory, `.raced-${staleId}`);
        await snapshotFixture(staleDirectory);

        expect(
            withDeploymentLease(state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                await retainProductionDatabaseSnapshots(
                    lease,
                    paths,
                    { activationTransitionIds: [], nowMs },
                    {
                        beforeSnapshotRetired: async (transitionId) => {
                            expect(transitionId).toBe(staleId);
                            await rename(staleDirectory, movedDirectory);
                            await snapshotFixture(staleDirectory);
                        },
                    }
                );
            })
        ).rejects.toThrow("Database snapshot retention failed");

        const staleEntries = await readdir(staleDirectory);
        expect(staleEntries.toSorted()).toEqual([
            "mira-dashboard.db",
            "snapshot-manifest.json",
        ]);
    });

    test("fails closed on an unknown root entry before pruning snapshots", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 3 * 24 * 60 * 60_000, 1);
        await snapshotFixture(path.join(state.backupsDirectory, staleId));
        await writeFile(path.join(state.backupsDirectory, "unexpected"), "fixture");

        expect(
            withDeploymentLease(state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                await retainProductionDatabaseSnapshots(lease, paths, {
                    activationTransitionIds: [],
                    nowMs,
                });
            })
        ).rejects.toThrow("Database snapshot retention failed");

        expect(await readdir(path.join(state.backupsDirectory, staleId))).toHaveLength(2);
    });

    test("resumes a hard crash after the atomic retire rename", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 3 * 24 * 60 * 60_000, 1);
        await snapshotFixture(path.join(state.backupsDirectory, staleId));

        expect(
            withDeploymentLease(state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                await retainProductionDatabaseSnapshots(
                    lease,
                    paths,
                    { activationTransitionIds: [], nowMs },
                    {
                        afterRetiredDirectorySynced: () => {
                            throw new Error("simulated hard crash");
                        },
                    }
                );
            })
        ).rejects.toThrow("Database snapshot retention failed");
        expect(await readdir(state.backupsDirectory)).toContain(`.retire-${staleId}`);

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await retainProductionDatabaseSnapshots(lease, paths, {
                activationTransitionIds: [],
                nowMs,
            });
        });
        expect(await readdir(state.backupsDirectory)).not.toContain(`.retire-${staleId}`);
    });

    test("resumes a hard crash after one retired file was removed", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 3 * 24 * 60 * 60_000, 1);
        await snapshotFixture(path.join(state.backupsDirectory, staleId));
        let interrupted = false;

        expect(
            withDeploymentLease(state.stateDirectory, async (lease) => {
                const paths = await prepareProductionDeliveryDirectories(state);
                await retainProductionDatabaseSnapshots(
                    lease,
                    paths,
                    { activationTransitionIds: [], nowMs },
                    {
                        afterRetiredFileRemoved: () => {
                            if (interrupted) return;
                            interrupted = true;
                            throw new Error("simulated hard crash");
                        },
                    }
                );
            })
        ).rejects.toThrow("Database snapshot retention failed");
        expect(
            await readdir(path.join(state.backupsDirectory, `.retire-${staleId}`))
        ).toHaveLength(1);

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await retainProductionDatabaseSnapshots(lease, paths, {
                activationTransitionIds: [],
                nowMs,
            });
        });
        expect(await readdir(state.backupsDirectory)).not.toContain(`.retire-${staleId}`);
    });

    test("reaps an unreferenced crash-left cutover stage but preserves an active one", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 60_000, 1);
        const activeId = uuidV7At(nowMs - 30_000, 2);
        await snapshotFixture(path.join(state.backupsDirectory, `.stage-${staleId}`));
        await snapshotFixture(path.join(state.backupsDirectory, `.stage-${activeId}`));

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await retainProductionDatabaseSnapshots(lease, paths, {
                activationTransitionIds: [],
                journalTransitionId: activeId,
                nowMs,
            });
        });

        const retained = await readdir(state.backupsDirectory);
        expect(retained).not.toContain(`.stage-${staleId}`);
        expect(retained).toContain(`.stage-${activeId}`);
    });

    test("resumes a crash-left cutover snapshot cleanup retire handoff", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-snapshot-retention-"));
        temporaryDirectories.push(root);
        const state = await prepareProtectedProductionStatePath(root);
        const nowMs = Date.now();
        const staleId = uuidV7At(nowMs - 60_000, 1);
        await snapshotFixture(
            path.join(state.backupsDirectory, `.retire-stage-${staleId}`)
        );

        await withDeploymentLease(state.stateDirectory, async (lease) => {
            const paths = await prepareProductionDeliveryDirectories(state);
            await retainProductionDatabaseSnapshots(lease, paths, {
                activationTransitionIds: [],
                nowMs,
            });
        });

        expect(await readdir(state.backupsDirectory)).not.toContain(
            `.retire-stage-${staleId}`
        );
    });
});
