import { realpathSync } from "node:fs";
import path from "node:path";

import { nonEmptyEnvironmentFallback } from "../../lib/values.ts";
import {
    commitAndPushPaths,
    type GitSyncResult,
    git,
    literalPathspec,
    parseStatusPaths,
    pushPendingAutomationCommits,
    withGitSyncLock,
} from "./gitClient.ts";

const DOCKER_SYNC_COMMIT_MESSAGE = "chore: update managed app images";
const DOCKER_COMPOSE_FILE_RE =
    /^(?:[^/]+\/)*(?:compose|docker-compose)(?:\.override)?\.ya?ml$/u;

function getDockerAppsRoot(): string {
    return nonEmptyEnvironmentFallback("MIRA_DOCKER_APPS_ROOT", "/opt/docker/apps");
}

function toGitPath(value: string): string {
    return value.split(path.sep).join("/");
}

function relativePath(basePath: string, targetPath: string): string | undefined {
    const relative = toGitPath(path.relative(basePath, targetPath));
    if (relative === "") return ".";
    if (relative === ".." || relative.startsWith("../")) return undefined;
    return relative;
}

function isDockerUpdaterSafePath(
    path_: string,
    appsPath: string,
    shouldAllowRepoRootCompose: boolean
): boolean {
    const dirname = path.dirname(path_);
    const isAncestorComposePath =
        shouldAllowRepoRootCompose &&
        (dirname === "." || appsPath.startsWith(`${dirname}/`));
    let relativeToApps: string | undefined;
    if (appsPath === "." || isAncestorComposePath) {
        relativeToApps = path_;
    } else if (path_.startsWith(`${appsPath}/`)) {
        relativeToApps = path_.slice(appsPath.length + 1);
    }
    return relativeToApps !== undefined && DOCKER_COMPOSE_FILE_RE.test(relativeToApps);
}

async function resolveDockerGitScope(
    signal?: AbortSignal
): Promise<{ appsPath: string; repoPath: string }> {
    const appsRoot = realpathSync(getDockerAppsRoot());
    const repoPath = await git(["rev-parse", "--show-toplevel"], {
        cwd: appsRoot,
        signal,
    });
    const appsPath = relativePath(repoPath, appsRoot);
    if (!appsPath) {
        throw new Error(`Docker apps root is outside git repository: ${appsRoot}`);
    }
    return { appsPath, repoPath };
}

async function dockerGitScope(
    signal?: AbortSignal
): Promise<{ appsPath: string; repoPath: string }> {
    return await resolveDockerGitScope(signal);
}

function normalizeDockerChangedPaths(
    repoPath: string,
    paths: string[] | undefined
): string[] | undefined {
    if (!paths) return undefined;
    return paths
        .map((path_) =>
            path.isAbsolute(path_) ? relativePath(repoPath, path.resolve(path_)) : path_
        )
        .filter((path_): path_ is string => Boolean(path_));
}

export async function dirtyDockerUpdaterPaths(
    paths: string[],
    signal?: AbortSignal
): Promise<Set<string> | undefined> {
    try {
        const scope = await dockerGitScope(signal);
        const statusPathspecs = normalizeDockerChangedPaths(scope.repoPath, paths) ?? [];
        if (statusPathspecs.length === 0) return new Set();
        const status = await git(
            [
                "status",
                "--porcelain=v1",
                "-z",
                "--",
                ...statusPathspecs.map((path_) => literalPathspec(path_)),
            ],
            { cwd: scope.repoPath, signal }
        );
        return new Set(
            parseStatusPaths(status).map((statusPath) =>
                path.resolve(scope.repoPath, statusPath)
            )
        );
    } catch {
        signal?.throwIfAborted();
        return undefined;
    }
}

export async function syncDockerUpdaterChanges(
    paths?: string[],
    signal?: AbortSignal,
    protectFromCancellation?: () => void
): Promise<GitSyncResult> {
    const scope = await dockerGitScope(signal);
    const { appsPath, repoPath } = scope;
    return withGitSyncLock(
        repoPath,
        async () => {
            const statusPathspecs = normalizeDockerChangedPaths(repoPath, paths);
            const safePaths =
                statusPathspecs?.length === 0
                    ? []
                    : parseStatusPaths(
                          await git(
                              [
                                  "status",
                                  "--porcelain=v1",
                                  "-z",
                                  "--",
                                  ...(statusPathspecs ?? [appsPath]).map((path_) =>
                                      literalPathspec(path_)
                                  ),
                              ],
                              {
                                  cwd: repoPath,
                                  signal,
                              }
                          )
                      ).filter((path_) =>
                          isDockerUpdaterSafePath(
                              path_,
                              appsPath,
                              statusPathspecs !== undefined
                          )
                      );
            if (safePaths.length === 0) {
                const pushedPending = await pushPendingAutomationCommits(
                    repoPath,
                    [DOCKER_SYNC_COMMIT_MESSAGE],
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
                DOCKER_SYNC_COMMIT_MESSAGE,
                signal,
                protectFromCancellation
            );
        },
        signal
    );
}
