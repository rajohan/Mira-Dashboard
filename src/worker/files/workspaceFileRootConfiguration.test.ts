import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { resolveReviewedWorkerWorkspaceFileRoot } from "./workspaceFileRootConfiguration.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function fixture() {
    const parent = await mkdtemp(path.join(tmpdir(), "mira-worker-files-root-"));
    temporaryDirectories.push(parent);
    const productionRoot = path.join(parent, "dashboard", "production");
    const workspaceRoot = path.join(parent, "workspace");
    await mkdir(productionRoot, { mode: 0o700, recursive: true });
    await mkdir(workspaceRoot, { mode: 0o700 });
    return { parent, productionRoot, workspaceRoot };
}

describe("reviewed worker workspace file root", () => {
    test("returns one exact writer-only root", async () => {
        const { productionRoot, workspaceRoot } = await fixture();

        expect(
            await resolveReviewedWorkerWorkspaceFileRoot(workspaceRoot, productionRoot)
        ).toEqual({ id: "workspace", path: workspaceRoot, writable: true });
    });

    test("rejects symlinks, writable roots, and production overlap", async () => {
        const { parent, productionRoot, workspaceRoot } = await fixture();
        const alias = path.join(parent, "workspace-link");
        await symlink(workspaceRoot, alias, "dir");

        expect(
            resolveReviewedWorkerWorkspaceFileRoot(alias, productionRoot)
        ).rejects.toThrow("Workspace file root is invalid");
        await chmod(workspaceRoot, 0o770);
        expect(
            resolveReviewedWorkerWorkspaceFileRoot(workspaceRoot, productionRoot)
        ).rejects.toThrow("Workspace file root is invalid");
        expect(
            resolveReviewedWorkerWorkspaceFileRoot(productionRoot, productionRoot)
        ).rejects.toThrow("Workspace file root is invalid");
    });
});
