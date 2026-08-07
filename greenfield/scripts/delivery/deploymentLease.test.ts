import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    mkdir,
    mkdtemp,
    open,
    rename,
    rm,
    symlink,
    unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { rejectionError } from "../testSupport/rejection.ts";
import { withDeploymentLease } from "./deploymentLease.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function stateFixture(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-deployment-lease-"));
    temporaryDirectories.push(root);
    const state = path.join(root, "state");
    await mkdir(state, { mode: 0o700 });
    return state;
}

describe("Dashboard deployment lease", () => {
    test("runs competing production transitions one at a time", async () => {
        const state = await stateFixture();
        const events: string[] = [];
        const firstMayFinish = Promise.withResolvers<void>();

        const first = withDeploymentLease(state, async () => {
            events.push("first-start");
            await firstMayFinish.promise;
            events.push("first-end");
        });
        await Bun.sleep(30);
        const second = withDeploymentLease(state, () => {
            events.push("second");
            return Promise.resolve();
        });
        await Bun.sleep(30);

        expect(events).toEqual(["first-start"]);
        firstMayFinish.resolve();
        await Promise.all([first, second]);
        expect(events).toEqual(["first-start", "first-end", "second"]);
    });

    test("waits while a competing process is publishing its lock record", async () => {
        const state = await stateFixture();
        const lockPath = path.join(state, ".deployment.lock");
        const initializingLock = await open(lockPath, "wx", 0o600);
        let entered = false;

        const transition = withDeploymentLease(state, () => {
            entered = true;
            return Promise.resolve();
        });
        await Bun.sleep(50);
        expect(entered).toBe(false);

        await initializingLock.close();
        await unlink(lockPath);
        await transition;
        expect(entered).toBe(true);
    });

    test("rejects permissive, replaced and linked state directories", async () => {
        const permissive = await stateFixture();
        await chmod(permissive, 0o755);
        const permissionFailure = await rejectionError(
            withDeploymentLease(permissive, () => Promise.resolve())
        );
        expect(permissionFailure.message).toBe("Dashboard deployment lease failed");

        const replaced = await stateFixture();
        const displaced = `${replaced}.displaced`;
        const replacement = `${replaced}.replacement`;
        await mkdir(replacement, { mode: 0o700 });
        const replacementFailure = await rejectionError(
            withDeploymentLease(replaced, async () => {
                await rename(replaced, displaced);
                await rename(replacement, replaced);
            })
        );
        expect(replacementFailure.message).toBe("Dashboard deployment lease failed");

        const symlinkRoot = await mkdtemp(
            path.join(tmpdir(), "mira-deployment-lease-link-")
        );
        temporaryDirectories.push(symlinkRoot);
        const target = path.join(symlinkRoot, "target");
        const link = path.join(symlinkRoot, "state");
        await mkdir(target, { mode: 0o700 });
        await symlink(target, link);
        const symlinkFailure = await rejectionError(
            withDeploymentLease(link, () => Promise.resolve())
        );
        expect(symlinkFailure.message).toBe("Dashboard deployment lease failed");
    });
});
