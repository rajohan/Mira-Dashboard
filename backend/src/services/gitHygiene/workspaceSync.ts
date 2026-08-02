import { homedir } from "node:os";
import path from "node:path";

import {
    commitAndPushPaths,
    type GitSyncResult,
    git,
    parseStatusPaths,
    pushPendingAutomationCommits,
    withGitSyncLock,
} from "./gitClient.ts";

const OPENCLAW_SYNC_COMMIT_MESSAGE = "chore: sync OpenClaw workspace state";
const OPENCLAW_SAFE_PATHS = [
    "workspace/AGENTS.md",
    "workspace/MEMORY.md",
    "workspace/DREAMS.md",
    "workspace/HEARTBEAT.md",
    "workspace/IDENTITY.md",
    "workspace/SOUL.md",
    "workspace/TOOLS.md",
    "workspace/USER.md",
    "workspace/WORKFLOW_AUTO.md",
    "workspace/memory/",
    "workspace/wiki/",
    "workspace/coder/",
    "workspace/communicator/",
    "workspace/researcher/",
] as const;

function getOpenClawRoot(): string {
    const homeDirectory = process.env.HOME?.trim() || homedir().trim();
    return (
        process.env.MIRA_OPENCLAW_ROOT?.trim() ||
        process.env.OPENCLAW_HOME?.trim() ||
        path.join(homeDirectory, ".openclaw")
    );
}

function isOpenClawSafePath(path_: string): boolean {
    return OPENCLAW_SAFE_PATHS.some((safePath) =>
        safePath.endsWith("/") ? path_.startsWith(safePath) : path_ === safePath
    );
}

export async function syncOpenClawWorkspaceSafePaths(
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<GitSyncResult> {
    const repoPath = getOpenClawRoot();
    return withGitSyncLock(
        repoPath,
        async () => {
            const status = await git(["status", "--porcelain=v1", "-z", "-uall"], {
                cwd: repoPath,
                signal,
            });
            const changedPaths = parseStatusPaths(status);
            const safePaths = changedPaths.filter((path_) => isOpenClawSafePath(path_));
            if (safePaths.length === 0) {
                const pushedPending = await pushPendingAutomationCommits(
                    repoPath,
                    [OPENCLAW_SYNC_COMMIT_MESSAGE],
                    signal,
                    protectFromCancellation
                );
                if (pushedPending) return pushedPending;
                return {
                    changedPaths: [],
                    pushed: false,
                    skippedReason: "no safe changes",
                };
            }
            return commitAndPushPaths(
                repoPath,
                safePaths,
                OPENCLAW_SYNC_COMMIT_MESSAGE,
                signal,
                protectFromCancellation
            );
        },
        signal
    );
}
