import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { deriveDashboardProjectLayout } from "../filesystem/projectLayout.ts";
import { resolveReviewedWorkspaceFileRoot } from "./workspaceFileRootConfiguration.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function fixture() {
    const parent = await mkdtemp(path.join(tmpdir(), "mira-files-root-"));
    temporaryDirectories.push(parent);
    const projectRoot = path.join(parent, "dashboard");
    const workspaceRoot = path.join(parent, "workspace");
    await mkdir(projectRoot, { mode: 0o700 });
    await mkdir(workspaceRoot, { mode: 0o700 });
    return {
        layout: deriveDashboardProjectLayout(projectRoot),
        parent,
        workspaceRoot,
    };
}

describe("reviewed workspace file root", () => {
    test("returns one exact writable named root", async () => {
        const { layout, workspaceRoot } = await fixture();

        expect(await resolveReviewedWorkspaceFileRoot(workspaceRoot, layout)).toEqual({
            id: "workspace",
            label: "Workspace",
            path: workspaceRoot,
            writable: true,
        });
    });

    test("rejects symlinks, writable roots, and production overlap", async () => {
        const { layout, parent, workspaceRoot } = await fixture();
        const alias = path.join(parent, "workspace-link");
        await symlink(workspaceRoot, alias, "dir");

        expect(resolveReviewedWorkspaceFileRoot(alias, layout)).rejects.toThrow(
            "Workspace file root is invalid"
        );

        await chmod(workspaceRoot, 0o770);
        expect(resolveReviewedWorkspaceFileRoot(workspaceRoot, layout)).rejects.toThrow(
            "Workspace file root is invalid"
        );

        await mkdir(layout.production.root, { recursive: true, mode: 0o700 });
        expect(
            resolveReviewedWorkspaceFileRoot(layout.production.root, layout)
        ).rejects.toThrow("Workspace file root is invalid");
        expect(resolveReviewedWorkspaceFileRoot(layout.root, layout)).rejects.toThrow(
            "Workspace file root is invalid"
        );
    });
});
