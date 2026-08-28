import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { ProductionDeliveryExecutorOwner } from "../../src/shared/productionDeliveryExecutorOwner.ts";
import { removeProductionDeliveryFixtures } from "../testSupport/productionDeliveryFixture.ts";
import { rejectionError } from "../testSupport/rejection.ts";
import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import {
    clearProductionDeliveryExecutorOwner,
    commitProductionDeliveryExecutorOwner,
    loadProductionDeliveryExecutorOwnerState,
} from "./productionDeliveryExecutorOwnerState.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";

const temporaryDirectories: string[] = [];
const transitionId = "018f0000-0000-7000-8000-000000000001";

function owner(
    release: string,
    runtime: string,
    transition = transitionId
): ProductionDeliveryExecutorOwner {
    return Object.freeze({
        formatVersion: 1,
        releaseId: release.repeat(40),
        runtimeRevision: runtime.repeat(40),
        transitionId: transition,
    });
}

async function fixture(): Promise<{
    lease: DashboardDeploymentLease;
    paths: PreparedProductionDeliveryPaths;
    stateDirectory: string;
}> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-executor-owner-"));
    temporaryDirectories.push(root);
    const stateDirectory = path.join(root, "state");
    await mkdir(stateDirectory);
    await chmod(stateDirectory, 0o700);
    return {
        lease: { stateDirectory } as DashboardDeploymentLease,
        paths: { stateDirectory } as PreparedProductionDeliveryPaths,
        stateDirectory,
    };
}

afterEach(async () => {
    await removeProductionDeliveryFixtures(temporaryDirectories);
});

describe("Production Delivery executor owner state", () => {
    test("durably initializes and transfers one transition between generations", async () => {
        const { lease, paths } = await fixture();
        const absent = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        expect(absent.owner).toBeUndefined();

        const current = await commitProductionDeliveryExecutorOwner(
            lease,
            paths,
            absent,
            owner("a", "b")
        );
        expect(current.owner).toEqual(owner("a", "b"));

        const target = await commitProductionDeliveryExecutorOwner(
            lease,
            paths,
            current,
            owner("c", "d")
        );
        expect(target.owner).toEqual(owner("c", "d"));
        const reloaded = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        expect(reloaded.owner).toEqual(owner("c", "d"));

        await clearProductionDeliveryExecutorOwner(lease, paths, reloaded);
        const cleared = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        expect(cleared.owner).toBeUndefined();
    });

    test("rejects stale CAS and cross-transition ownership changes", async () => {
        const { lease, paths } = await fixture();
        const absent = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        const current = await commitProductionDeliveryExecutorOwner(
            lease,
            paths,
            absent,
            owner("a", "b")
        );
        await commitProductionDeliveryExecutorOwner(
            lease,
            paths,
            current,
            owner("c", "d")
        );

        const staleError = await rejectionError(
            commitProductionDeliveryExecutorOwner(lease, paths, current, owner("e", "f"))
        );
        expect(staleError.message).toBe(
            "Production Delivery executor owner state failed"
        );
        const latest = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        const crossTransitionError = await rejectionError(
            commitProductionDeliveryExecutorOwner(
                lease,
                paths,
                latest,
                owner("e", "f", "018f0000-0000-7000-8000-000000000002")
            )
        );
        expect(crossTransitionError.message).toBe(
            "Production Delivery executor owner state failed"
        );
    });

    test("rejects owner-file replacement during a recovery read", async () => {
        const { lease, paths, stateDirectory } = await fixture();
        const absent = await loadProductionDeliveryExecutorOwnerState(lease, paths);
        await commitProductionDeliveryExecutorOwner(
            lease,
            paths,
            absent,
            owner("a", "b")
        );
        const error = await rejectionError(
            loadProductionDeliveryExecutorOwnerState(lease, paths, {
                afterRead: () =>
                    writeFile(
                        path.join(
                            stateDirectory,
                            "delivery-production-executor-owner.json"
                        ),
                        `${JSON.stringify(owner("c", "d"))}\n`,
                        { mode: 0o600 }
                    ),
            })
        );
        expect(error.message).toBe("Production Delivery executor owner state failed");
    });
});
