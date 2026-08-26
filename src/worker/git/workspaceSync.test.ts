import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { createWorkspaceGitSync } from "./workspaceSync.ts";

const roots: string[] = [];

function run(root: string, arguments_: readonly string[]): string {
    return Bun.spawnSync(["/usr/bin/git", ...arguments_], {
        cwd: root,
        stderr: "pipe",
        stdout: "pipe",
    })
        .stdout.toString()
        .trim();
}

function fixture(): { readonly origin: string; readonly workspace: string } {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "workspace-sync-"));
    roots.push(root);
    const origin = Path.join(root, "origin.git");
    const workspace = Path.join(root, "workspace");
    Fs.mkdirSync(workspace);
    run(root, ["init", "--bare", origin]);
    run(workspace, ["init", "--initial-branch=main"]);
    run(workspace, ["config", "user.name", "Mira Test"]);
    run(workspace, ["config", "user.email", "mira-test@example.invalid"]);
    run(workspace, ["remote", "add", "origin", origin]);
    Fs.writeFileSync(Path.join(workspace, "tracked.md"), "initial\n");
    run(workspace, ["add", "tracked.md"]);
    run(workspace, ["commit", "-m", "initial"]);
    run(workspace, ["push", "--set-upstream", "origin", "main"]);
    return { origin, workspace };
}

afterEach(() => {
    for (const root of roots.splice(0)) Fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenClaw workspace Git sync", () => {
    test("commits and pushes tracked changes without admitting untracked files", async () => {
        const { origin, workspace } = fixture();
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");
        Fs.writeFileSync(Path.join(workspace, "untracked.md"), "private\n");

        const result = await createWorkspaceGitSync(workspace)();

        expect(result).toMatchObject({ changedFileCount: 1, pushed: true });
        expect(run(origin, ["show", "main:tracked.md"])).toBe("updated");
        expect(run(workspace, ["status", "--porcelain=v1"])).toBe("?? untracked.md");
    });

    test("does not create an empty commit", async () => {
        const { workspace } = fixture();
        expect(await createWorkspaceGitSync(workspace)()).toEqual({
            changedFileCount: 0,
            pushed: false,
        });
    });
});
