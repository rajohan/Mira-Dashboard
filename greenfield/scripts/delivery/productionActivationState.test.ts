import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";
import {
    commitProductionActivationState,
    loadProductionActivationState,
} from "./productionActivationState.ts";
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
    const projectRoot = await mkdtemp(path.join(tmpdir(), "mira-activation-state-"));
    temporaryDirectories.push(projectRoot);
    const state = await prepareProtectedProductionStatePath(projectRoot);
    const paths = await prepareProductionDeliveryDirectories(state);
    return { paths, state };
}

describe("production activation state", () => {
    test("atomically records initial and subsequent release/database pairs", async () => {
        const { paths } = await fixture();
        const firstTransition = Bun.randomUUIDv7();
        const secondTransition = Bun.randomUUIDv7();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const empty = await loadProductionActivationState(lease, paths);
            expect(empty.record).toBeUndefined();
            const first = await commitProductionActivationState(lease, paths, empty, {
                current: {
                    releaseId: "a".repeat(40),
                    runtimeRevision: "b".repeat(40),
                },
                formatVersion: 1,
                previous: null,
                transitionId: firstTransition,
            });
            expect(first.record?.previous).toBeNull();
            const second = await commitProductionActivationState(lease, paths, first, {
                current: {
                    releaseId: "c".repeat(40),
                    runtimeRevision: "d".repeat(40),
                },
                formatVersion: 1,
                previous: {
                    databaseSnapshotTransitionId: secondTransition,
                    releaseId: "a".repeat(40),
                    runtimeRevision: "b".repeat(40),
                },
                transitionId: secondTransition,
            });

            expect(second.record?.previous).toEqual({
                databaseSnapshotTransitionId: secondTransition,
                releaseId: "a".repeat(40),
                runtimeRevision: "b".repeat(40),
            });
            const activationStatus = await stat(
                path.join(paths.stateDirectory, "activation.json")
            );
            expect(activationStatus.mode & 0o777).toBe(0o600);
            const stateEntries = await readdir(paths.stateDirectory);
            expect(
                stateEntries.filter((entry) => entry.startsWith(".activation-"))
            ).toEqual([]);
        });
    });

    test("rejects stale compare-and-swap state and invalid previous pairing", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const empty = await loadProductionActivationState(lease, paths);
            const transitionId = Bun.randomUUIDv7();
            const current = await commitProductionActivationState(lease, paths, empty, {
                current: {
                    releaseId: "a".repeat(40),
                    runtimeRevision: "b".repeat(40),
                },
                formatVersion: 1,
                previous: null,
                transitionId,
            });
            const nextTransition = Bun.randomUUIDv7();
            const staleFailure = await rejectionError(
                commitProductionActivationState(lease, paths, empty, {
                    current: {
                        releaseId: "c".repeat(40),
                        runtimeRevision: "d".repeat(40),
                    },
                    formatVersion: 1,
                    previous: null,
                    transitionId: nextTransition,
                })
            );
            expect(staleFailure.message).toBe(
                "Production activation state update failed"
            );

            const pairingFailure = await rejectionError(
                commitProductionActivationState(lease, paths, current, {
                    current: {
                        releaseId: "c".repeat(40),
                        runtimeRevision: "d".repeat(40),
                    },
                    formatVersion: 1,
                    previous: {
                        databaseSnapshotTransitionId: transitionId,
                        releaseId: "f".repeat(40),
                        runtimeRevision: "b".repeat(40),
                    },
                    transitionId: nextTransition,
                })
            );
            expect(pairingFailure.message).toBe(
                "Production activation state update failed"
            );
        });
    });
});
