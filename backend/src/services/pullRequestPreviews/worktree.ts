import { existsSync, readdirSync, realpathSync, rmdirSync } from "node:fs";
import path from "node:path";

import {
    githubCommandEnvironment,
    runCommand,
    safeInstallEnvironment,
} from "./commands.ts";
import {
    ensureRealDirectoryPreservingExistingMode,
    isRealDirectory,
} from "./fileSystem.ts";
import type { PullRequestPreviewConfig } from "./types.ts";

export const PREVIEW_REFERENCE = "refs/mira-dashboard/previews/active";

export function previewWorktreePath(config: PullRequestPreviewConfig): string {
    return config.managedWorktreePath;
}

async function unregisterPreviewWorktreeIfRegistered(
    config: PullRequestPreviewConfig,
    worktreePath: string,
    signal?: AbortSignal
): Promise<boolean> {
    const resolvedWorktreePath = path.resolve(worktreePath);
    const { stdout } = await runCommand(
        "git",
        ["-C", config.dashboardRoot, "worktree", "list", "--porcelain"],
        { signal, timeoutMs: 30_000 }
    );
    const isRegistered = stdout
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("worktree "))
        .some(
            (line) =>
                path.resolve(line.slice("worktree ".length)) === resolvedWorktreePath
        );
    if (!isRegistered) return false;
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "worktree",
            "remove",
            "--force",
            "--force",
            resolvedWorktreePath,
        ],
        { signal, timeoutMs: 120_000 }
    );
    return true;
}

export async function removePreviewWorktree(
    config: PullRequestPreviewConfig,
    worktreePath: string,
    signal?: AbortSignal
): Promise<boolean> {
    const resolvedWorktreePath = path.resolve(worktreePath);
    if (resolvedWorktreePath !== path.resolve(config.managedWorktreePath)) {
        throw new Error("Refusing to remove an unmanaged preview worktree");
    }
    if (!existsSync(resolvedWorktreePath)) {
        return unregisterPreviewWorktreeIfRegistered(
            config,
            resolvedWorktreePath,
            signal
        );
    }
    if (!isRealDirectory(resolvedWorktreePath)) {
        throw new Error("Preview worktree path must be a real directory");
    }
    const { stdout: registeredRoot } = await runCommand(
        "git",
        ["-C", resolvedWorktreePath, "rev-parse", "--show-toplevel"],
        { signal }
    );
    if (realpathSync(registeredRoot.trim()) !== realpathSync(resolvedWorktreePath)) {
        throw new Error("Preview path is not the expected registered worktree");
    }
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "worktree",
            "remove",
            "--force",
            resolvedWorktreePath,
        ],
        { signal, timeoutMs: 120_000 }
    );
    if (existsSync(resolvedWorktreePath)) {
        throw new Error("Git did not remove the managed preview worktree");
    }
    return true;
}

export async function ensurePreviewWorktree(
    config: PullRequestPreviewConfig,
    number: number,
    commitSha: string,
    signal?: AbortSignal
): Promise<string> {
    ensureRealDirectoryPreservingExistingMode(path.dirname(config.managedWorktreePath));
    const worktreePath = previewWorktreePath(config);
    await runCommand(
        "git",
        [
            "-C",
            config.dashboardRoot,
            "fetch",
            "--force",
            "--no-tags",
            "origin",
            `pull/${number}/head:${PREVIEW_REFERENCE}`,
        ],
        {
            env: githubCommandEnvironment(),
            signal,
            timeoutMs: 180_000,
        }
    );
    const { stdout: fetchedCommit } = await runCommand(
        "git",
        ["-C", config.dashboardRoot, "rev-parse", PREVIEW_REFERENCE],
        { env: githubCommandEnvironment(), signal }
    );
    if (fetchedCommit.trim() !== commitSha) {
        throw new Error("Fetched pull request commit changed during preview startup");
    }
    if (existsSync(worktreePath)) {
        if (!isRealDirectory(worktreePath)) {
            throw new Error("Preview worktree path must be a real directory");
        }
        if (readdirSync(worktreePath).length === 0) {
            await unregisterPreviewWorktreeIfRegistered(config, worktreePath, signal);
            if (existsSync(worktreePath)) {
                rmdirSync(worktreePath);
            }
        }
    }
    if (existsSync(worktreePath)) {
        const { stdout: registeredRoot } = await runCommand(
            "git",
            ["-C", worktreePath, "rev-parse", "--show-toplevel"],
            { signal }
        );
        if (realpathSync(registeredRoot.trim()) !== realpathSync(worktreePath)) {
            throw new Error("Preview path is not the expected registered worktree");
        }
        const { stdout: status } = await runCommand(
            "git",
            ["-C", worktreePath, "status", "--porcelain", "--untracked-files=no"],
            { signal }
        );
        if (status.trim()) {
            throw Object.assign(
                new Error("Managed preview worktree has tracked local changes"),
                { statusCode: 409 }
            );
        }
        await runCommand("git", ["-C", worktreePath, "checkout", "--detach", commitSha], {
            signal,
        });
    } else {
        await unregisterPreviewWorktreeIfRegistered(config, worktreePath, signal);
        await runCommand(
            "git",
            [
                "-C",
                config.dashboardRoot,
                "worktree",
                "add",
                "--detach",
                worktreePath,
                commitSha,
            ],
            { signal, timeoutMs: 180_000 }
        );
    }
    const { stdout: checkedOutCommit } = await runCommand(
        "git",
        ["-C", worktreePath, "rev-parse", "HEAD"],
        { signal }
    );
    if (checkedOutCommit.trim() !== commitSha) {
        throw new Error("Preview worktree commit verification failed");
    }
    return worktreePath;
}

export async function installPreviewDependencies(
    config: PullRequestPreviewConfig,
    worktreePath: string,
    signal?: AbortSignal
): Promise<void> {
    const environment = safeInstallEnvironment(config);
    await runCommand(
        config.bunExecutable,
        ["install", "--frozen-lockfile", "--ignore-scripts"],
        {
            cwd: worktreePath,
            env: environment,
            signal,
            timeoutMs: 5 * 60 * 1000,
        }
    );
}
