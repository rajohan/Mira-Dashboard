import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { prepareProductionDeliveryDirectories } from "./productionDeliveryFilesystem.ts";
import { prepareProtectedProductionStatePath } from "./productionStateFilesystem.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function projectFixture(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-production-delivery-"));
    temporaryDirectories.push(root);
    return root;
}

describe("production delivery filesystem", () => {
    test("creates private project-local release and runtime roots idempotently", async () => {
        const root = await projectFixture();
        const state = await prepareProtectedProductionStatePath(root);
        const first = await prepareProductionDeliveryDirectories(state);
        const second = await prepareProductionDeliveryDirectories(state);

        expect(first).toEqual({
            productionDirectory: path.join(root, "production"),
            releasesDirectory: path.join(root, "production/releases"),
            runtimesDirectory: path.join(root, "production/runtimes"),
            stateDirectory: path.join(root, "production/state"),
        });
        expect(second).toEqual(first);
        const releasesStatus = await stat(first.releasesDirectory);
        const runtimesStatus = await stat(first.runtimesDirectory);
        expect(releasesStatus.mode & 0o777).toBe(0o700);
        expect(runtimesStatus.mode & 0o777).toBe(0o700);
    });

    test("only narrows existing modes and rejects links or missing owner access", async () => {
        const narrowedRoot = await projectFixture();
        const narrowedState = await prepareProtectedProductionStatePath(narrowedRoot);
        const narrowedReleases = path.join(narrowedState.productionDirectory, "releases");
        await mkdir(narrowedReleases, { mode: 0o755 });
        const narrowed = await prepareProductionDeliveryDirectories(narrowedState);
        const narrowedStatus = await stat(narrowed.releasesDirectory);
        expect(narrowedStatus.mode & 0o777).toBe(0o700);

        const restrictiveRoot = await projectFixture();
        const restrictiveState =
            await prepareProtectedProductionStatePath(restrictiveRoot);
        await mkdir(path.join(restrictiveState.productionDirectory, "releases"), {
            mode: 0o600,
        });
        const restrictiveFailure = await rejectionError(
            prepareProductionDeliveryDirectories(restrictiveState)
        );
        expect(restrictiveFailure.message).toBe(
            "Production delivery path violates the protected project-local filesystem policy"
        );

        const linkedRoot = await projectFixture();
        const linkedState = await prepareProtectedProductionStatePath(linkedRoot);
        const target = path.join(linkedRoot, "linked-releases-target");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, path.join(linkedState.productionDirectory, "releases"));
        const linkedFailure = await rejectionError(
            prepareProductionDeliveryDirectories(linkedState)
        );
        expect(linkedFailure.message).toBe(
            "Production delivery path violates the protected project-local filesystem policy"
        );

        await chmod(path.join(restrictiveState.productionDirectory, "releases"), 0o700);
    });
});
