import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, rm, stat } from "node:fs/promises";
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

function absentTransition(transitionId: string): ProductionActivationTransition {
    return {
        candidate: {
            releaseId: "a".repeat(40),
            runtimeRevision: "b".repeat(40),
        },
        formatVersion: 1,
        phase: "prepared",
        previousActivation: null,
        previousDatabase: { state: "absent" },
        transitionId,
    };
}

describe("production activation journal", () => {
    test("durably advances prepared to database-promoted and clears exactly", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            expect(await loadProductionActivationJournal(lease, paths)).toBeUndefined();
            const prepared = await createProductionActivationJournal(
                lease,
                paths,
                absentTransition(Bun.randomUUIDv7())
            );
            const loadedPrepared = await loadProductionActivationJournal(lease, paths);
            expect(loadedPrepared?.phase).toBe("prepared");
            const promoted = await markProductionDatabasePromoted(lease, paths, prepared);
            expect(promoted.phase).toBe("database-promoted");
            await clearProductionActivationJournal(lease, paths, promoted);
            expect(await loadProductionActivationJournal(lease, paths)).toBeUndefined();
        });
    });

    test("rejects competing creation and stale phase updates", async () => {
        const { paths } = await fixture();
        await withDeploymentLease(paths.stateDirectory, async (lease) => {
            const first = await createProductionActivationJournal(
                lease,
                paths,
                absentTransition(Bun.randomUUIDv7())
            );
            const competingFailure = await rejectionError(
                createProductionActivationJournal(
                    lease,
                    paths,
                    absentTransition(Bun.randomUUIDv7())
                )
            );
            expect(competingFailure.message).toBe(
                "Production activation journal update failed"
            );
            const promoted = await markProductionDatabasePromoted(lease, paths, first);
            const staleFailure = await rejectionError(
                markProductionDatabasePromoted(lease, paths, first)
            );
            expect(staleFailure.message).toBe(
                "Production activation journal update failed"
            );
            await clearProductionActivationJournal(lease, paths, promoted);
        });
    });
});
