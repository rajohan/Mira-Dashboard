import path from "node:path";

import type { ProductionCheckoutStatus } from "../../../../contracts/delivery/deployments.ts";
import type { WorktreeCleanupResult } from "../../../../contracts/delivery/previews.ts";
import { errorMessage } from "../../lib/errors.ts";
import { DEFAULT_BASE, getDashboardRoot, getDashboardWorktreeRoot } from "./config.ts";
import { runCommand } from "./githubCommandClient.ts";

interface GitWorktree {
    path: string;
    branch?: string;
    head?: string;
}

/**
 * Parses `git worktree list --porcelain` output.
 * @param output Git worktree porcelain output.
 * @returns Parsed worktree records.
 */
function parseGitWorktrees(output: string): GitWorktree[] {
    return output
        .trim()
        .split(/\n\s*\n/)
        .filter(Boolean)
        .map((block) => {
            const worktree: GitWorktree = { path: "" };
            for (const line of block.split("\n")) {
                if (line.startsWith("worktree ")) {
                    worktree.path = line.slice("worktree ".length);
                }
                if (line.startsWith("HEAD ")) {
                    worktree.head = line.slice("HEAD ".length);
                }
                if (line.startsWith("branch ")) {
                    worktree.branch = line.slice("branch ".length);
                }
            }
            return worktree;
        })
        .filter((worktree) => worktree.path);
}

/**
 * Returns whether a path is strictly inside the configured worktree root.
 * @param value Value to process.
 * @param root Root value.
 * @returns Whether a path is strictly inside the configured worktree root.
 */
function isPathInsideRoot(value: string, root: string): boolean {
    const resolvedValue = path.resolve(value);
    const resolvedRoot = path.resolve(root);
    const relative = path.relative(resolvedRoot, resolvedValue);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

/**
 * Performs find worktree for branch.
 * @param branch Branch value.
 * @param signal Signal used to cancel the operation.
 * @returns Find worktree for branch result.
 */
async function findWorktreeForBranch(
    branch: string,
    signal?: AbortSignal
): Promise<GitWorktree | undefined> {
    const { stdout } = await runCommand("git", ["worktree", "list", "--porcelain"], {
        signal,
        timeoutMs: 30_000,
    });
    const expectedReference = `refs/heads/${branch}`;
    return (
        parseGitWorktrees(stdout).find(
            (worktree) =>
                worktree.branch === expectedReference || worktree.branch === branch
        ) || undefined
    );
}

/**
 * Performs cleanup pull request worktree.
 * @param branch Branch value.
 * @param signal Signal used to cancel the operation.
 * @returns Cleanup pull request worktree result.
 */
export async function cleanupPullRequestWorktree(
    branch: string,
    signal?: AbortSignal
): Promise<WorktreeCleanupResult> {
    try {
        const worktree = await findWorktreeForBranch(branch, signal);
        if (!worktree) {
            return {
                status: "skipped",
                branch,
                message: `No local worktree found for ${branch}`,
            };
        }

        const worktreePath = path.resolve(worktree.path);
        const dashboardWorktreeRoot = getDashboardWorktreeRoot();
        if (!isPathInsideRoot(worktreePath, dashboardWorktreeRoot)) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}. Worktree path is outside ${dashboardWorktreeRoot}`,
            };
        }

        const { stdout: status } = await runCommand(
            "git",
            ["-C", worktreePath, "status", "--short"],
            { signal, timeoutMs: 30_000 }
        );
        if (status.trim()) {
            return {
                status: "warning",
                branch,
                path: worktreePath,
                message: `Skipped cleanup for ${branch}. Worktree has local changes`,
            };
        }

        await runCommand("git", ["worktree", "remove", worktreePath], {
            signal,
            timeoutMs: 60_000,
        });

        return {
            status: "removed",
            branch,
            path: worktreePath,
            message: `Removed local worktree for ${branch}`,
        };
    } catch (error) {
        return {
            status: "warning",
            branch,
            message: `Worktree cleanup warning for ${branch}: ${errorMessage(error, branch)}`,
        };
    }
}

/**
 * Reads and validates the production checkout state used to gate deployments.
 * @param signal Signal used to cancel Git commands.
 * @returns Production checkout status.
 */
export async function getProductionCheckoutStatus(
    signal?: AbortSignal
): Promise<ProductionCheckoutStatus> {
    const [{ stdout: root }, { stdout: branch }, { stdout: head }, { stdout: status }] =
        await Promise.all([
            runCommand("git", ["rev-parse", "--show-toplevel"], {
                signal,
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
                signal,
                timeoutMs: 30_000,
            }),
            runCommand("git", ["rev-parse", "HEAD"], {
                signal,
                timeoutMs: 30_000,
            }),
            runCommand("git", ["status", "--short"], {
                signal,
                timeoutMs: 30_000,
            }),
        ]);

    let upstream: string | undefined;
    try {
        const { stdout } = await runCommand(
            "git",
            ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
            { signal, timeoutMs: 30_000 }
        );
        upstream = stdout.trim() || undefined;
    } catch {
        upstream = undefined;
    }

    const productionRoot = root.trim();
    const dashboardRoot = getDashboardRoot();
    const dashboardWorktreeRoot = getDashboardWorktreeRoot();
    const currentBranch = branch.trim();
    const statusShort = status.trim();
    const isClean = statusShort.length === 0;
    const isProductionRoot = path.resolve(productionRoot) === path.resolve(dashboardRoot);

    return {
        root: productionRoot,
        expectedRoot: dashboardRoot,
        worktreeRoot: dashboardWorktreeRoot,
        branch: currentBranch,
        expectedBranch: DEFAULT_BASE,
        head: head.trim().slice(0, 8),
        headCommit: head.trim(),
        upstream,
        isClean,
        isProductionRoot,
        isSafeForDeploy: isClean && isProductionRoot && currentBranch === DEFAULT_BASE,
        statusShort: statusShort || undefined,
    };
}

/** Performs ensure production checkout. */
export async function ensureProductionCheckout(signal?: AbortSignal): Promise<void> {
    const status = await getProductionCheckoutStatus(signal);

    if (!status.isProductionRoot) {
        throw new Error(
            `Expected production checkout at ${getDashboardRoot()}, got ${status.root}`
        );
    }

    if (!status.isClean) {
        throw new Error("Production checkout has local changes. Refusing deploy/merge");
    }
}

/** Performs ensure production ready for deploy. */
export async function ensureProductionReadyForDeploy(
    signal?: AbortSignal
): Promise<void> {
    const status = await getProductionCheckoutStatus(signal);

    if (!status.isSafeForDeploy) {
        throw new Error(
            `Production checkout must be clean ${DEFAULT_BASE} before deploy. Current branch=${status.branch}, clean=${status.isClean}`
        );
    }
}

/** Performs sync main. */
export async function syncMain(signal?: AbortSignal): Promise<void> {
    await ensureProductionCheckout(signal);
    await runCommand("git", ["fetch", "--prune", "origin"], {
        signal,
        timeoutMs: 120_000,
    });
    await runCommand("git", ["checkout", DEFAULT_BASE], {
        signal,
        timeoutMs: 60_000,
    });
    await runCommand("git", ["pull", "--ff-only", "origin", DEFAULT_BASE], {
        signal,
        timeoutMs: 120_000,
    });
    await ensureProductionReadyForDeploy(signal);
}
