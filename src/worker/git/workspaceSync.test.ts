import { afterEach, describe, expect, test } from "bun:test";
import Fs from "node:fs";
import Os from "node:os";
import Path from "node:path";

import { WorkspaceGitSyncOutcomeUnknownError } from "../../shared/workspaceGitSync.ts";
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

function fixture(): {
    readonly origin: string;
    readonly repository: string;
    readonly workspace: string;
} {
    const root = Fs.mkdtempSync(Path.join(Os.tmpdir(), "workspace-sync-"));
    roots.push(root);
    const origin = Path.join(root, "origin.git");
    const repository = Path.join(root, "repository");
    const workspace = Path.join(repository, "workspace");
    Fs.mkdirSync(workspace, { recursive: true });
    run(root, ["init", "--bare", origin]);
    run(repository, ["init", "--initial-branch=main"]);
    run(repository, ["config", "user.name", "Mira Test"]);
    run(repository, ["config", "user.email", "mira-test@example.invalid"]);
    run(repository, ["remote", "add", "origin", origin]);
    Fs.writeFileSync(Path.join(workspace, "tracked.md"), "initial\n");
    run(repository, ["add", "workspace/tracked.md"]);
    run(repository, ["commit", "-m", "initial"]);
    run(repository, ["push", "--set-upstream", "origin", "main"]);
    return { origin, repository, workspace };
}

afterEach(() => {
    for (const root of roots.splice(0)) Fs.rmSync(root, { force: true, recursive: true });
});

describe("OpenClaw workspace Git sync", () => {
    test("commits and pushes tracked changes without admitting untracked files", async () => {
        const { origin, repository, workspace } = fixture();
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");
        Fs.writeFileSync(Path.join(workspace, "untracked.md"), "private\n");

        const result = await createWorkspaceGitSync(repository)();

        expect(result).toMatchObject({ changedFileCount: 1, pushed: true });
        expect(run(origin, ["show", "main:workspace/tracked.md"])).toBe("updated");
        expect(run(repository, ["status", "--porcelain=v1"])).toBe(
            "?? workspace/untracked.md"
        );
    });

    test("does not create an empty commit", async () => {
        const { repository } = fixture();
        expect(await createWorkspaceGitSync(repository)()).toEqual({
            changedFileCount: 0,
            pushed: false,
        });
    });

    test("preserves and excludes staged files outside workspace", async () => {
        const { origin, repository, workspace } = fixture();
        const outside = Path.join(repository, "outside.md");
        Fs.writeFileSync(outside, "initial\n");
        run(repository, ["add", "outside.md"]);
        run(repository, ["commit", "-m", "add outside fixture"]);
        run(repository, ["push", "origin", "main"]);
        Fs.writeFileSync(outside, "staged outside\n");
        run(repository, ["add", "outside.md"]);
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");

        const result = await createWorkspaceGitSync(repository)();

        expect(result).toMatchObject({ changedFileCount: 1, pushed: true });
        expect(run(origin, ["show", "main:workspace/tracked.md"])).toBe("updated");
        expect(run(origin, ["show", "main:outside.md"])).toBe("initial");
        expect(run(repository, ["diff", "--cached", "--name-only"])).toBe("outside.md");
    });

    test("restores the clean index when atomic HEAD publication fails", async () => {
        const { repository, workspace } = fixture();
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");
        const heads = Path.join(repository, ".git", "refs", "heads");
        Fs.chmodSync(heads, 0o500);

        const failure = await createWorkspaceGitSync(repository)()
            .catch((error: unknown) => error)
            .finally(() => Fs.chmodSync(heads, 0o700));

        expect(failure).toBeInstanceOf(Error);
        expect(run(repository, ["diff", "--cached", "--name-only"])).toBe("");
        expect(run(repository, ["status", "--porcelain=v1"])).toBe(
            "M workspace/tracked.md"
        );
    });

    test("restores HEAD when the shared index is locked after publication", async () => {
        const { repository, workspace } = fixture();
        const originalHead = run(repository, ["rev-parse", "HEAD"]);
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");
        const indexLock = Path.join(repository, ".git", "index.lock");
        Fs.writeFileSync(indexLock, "");

        const failure = await createWorkspaceGitSync(repository)()
            .catch((error: unknown) => error)
            .finally(() => Fs.rmSync(indexLock, { force: true }));

        expect(failure).toBeInstanceOf(Error);
        expect(run(repository, ["rev-parse", "HEAD"])).toBe(originalHead);
        expect(run(repository, ["status", "--porcelain=v1"])).toBe(
            "M workspace/tracked.md"
        );
    });

    test("rejects an in-progress merge with unmerged workspace entries", async () => {
        const { origin, repository, workspace } = fixture();
        run(repository, ["checkout", "-b", "conflicting-change"]);
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "branch\n");
        run(repository, ["add", "workspace/tracked.md"]);
        run(repository, ["commit", "-m", "branch change"]);
        run(repository, ["checkout", "main"]);
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "main\n");
        run(repository, ["add", "workspace/tracked.md"]);
        run(repository, ["commit", "-m", "main change"]);
        run(repository, ["push", "origin", "main"]);
        Bun.spawnSync(["/usr/bin/git", "merge", "conflicting-change"], {
            cwd: repository,
            stderr: "ignore",
            stdout: "ignore",
        });
        const remoteHead = run(origin, ["rev-parse", "refs/heads/main"]);

        const failure = await createWorkspaceGitSync(repository)().catch(
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "Workspace Git source is not synchronized"
        );
        expect(run(origin, ["rev-parse", "refs/heads/main"])).toBe(remoteHead);
    });

    test("rejects recovery when a pending automation commit changed another path", async () => {
        const { repository, workspace } = fixture();
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");
        Fs.writeFileSync(Path.join(repository, "outside.md"), "outside\n");
        run(repository, ["add", "workspace/tracked.md", "outside.md"]);
        run(repository, ["commit", "-m", "chore: sync OpenClaw workspace state"]);

        const failure = await createWorkspaceGitSync(repository)().catch(
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
            "Workspace Git source is not synchronized"
        );
    });

    test("recovers workspace-only paths with Unicode and control characters", async () => {
        const { origin, repository, workspace } = fixture();
        const fileName = "unicode-é\ncontrol.md";
        Fs.writeFileSync(Path.join(workspace, fileName), "tracked\n");
        run(repository, ["add", `workspace/${fileName}`]);
        run(repository, ["commit", "-m", "chore: sync OpenClaw workspace state"]);
        const pendingCommit = run(repository, ["rev-parse", "HEAD"]);

        const result = await createWorkspaceGitSync(repository)();

        expect(result).toEqual({
            changedFileCount: 0,
            commit: pendingCommit,
            pushed: true,
        });
        expect(run(origin, ["rev-parse", "refs/heads/main"])).toBe(pendingCommit);
    });

    test("classifies a concurrent remote advance as an unknown push outcome", async () => {
        const { origin, repository, workspace } = fixture();
        const hook = Path.join(repository, ".git", "hooks", "pre-push");
        Fs.writeFileSync(
            hook,
            `#!/bin/sh
head=$(/usr/bin/git --git-dir='${origin}' rev-parse refs/heads/main)
tree=$(/usr/bin/git --git-dir='${origin}' rev-parse "$head^{tree}")
next=$(printf '%s\\n' 'remote advance' | GIT_AUTHOR_NAME='Mira Test' GIT_AUTHOR_EMAIL='mira-test@example.invalid' GIT_COMMITTER_NAME='Mira Test' GIT_COMMITTER_EMAIL='mira-test@example.invalid' /usr/bin/git --git-dir='${origin}' commit-tree "$tree" -p "$head")
/usr/bin/git --git-dir='${origin}' update-ref refs/heads/main "$next"
exit 1
`,
            { mode: 0o700 }
        );
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "updated\n");

        const failure = await createWorkspaceGitSync(repository)().catch(
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(WorkspaceGitSyncOutcomeUnknownError);
    });

    test("classifies a rejected second push against the recovered remote head", async () => {
        const { origin, repository, workspace } = fixture();
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "pending\n");
        run(repository, ["add", "workspace/tracked.md"]);
        run(repository, ["commit", "-m", "chore: sync OpenClaw workspace state"]);
        const recoveredCommit = run(repository, ["rev-parse", "HEAD"]);
        Fs.writeFileSync(Path.join(workspace, "tracked.md"), "new change\n");
        const hook = Path.join(repository, ".git", "hooks", "pre-push");
        const marker = Path.join(repository, ".git", "first-push-complete");
        Fs.writeFileSync(
            hook,
            `#!/bin/sh
if [ ! -e '${marker}' ]; then
    touch '${marker}'
    exit 0
fi
exit 1
`,
            { mode: 0o700 }
        );

        const failure = await createWorkspaceGitSync(repository)().catch(
            (error: unknown) => error
        );

        expect(failure).toBeInstanceOf(Error);
        expect(failure).not.toBeInstanceOf(WorkspaceGitSyncOutcomeUnknownError);
        expect(run(origin, ["rev-parse", "refs/heads/main"])).toBe(recoveredCommit);
    });
});
