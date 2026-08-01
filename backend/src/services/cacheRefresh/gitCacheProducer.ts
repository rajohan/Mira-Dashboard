import { resolveDashboardProjectPaths } from "../../lib/dashboardPaths.ts";
import { writeCacheSuccess } from "../cacheEntryWriter.ts";
import { errorMessage, nowIso, runCacheCommand } from "./cacheProducerSupport.ts";

const dashboardProjectPaths = resolveDashboardProjectPaths();

const gitRepos = [
    {
        key: "openclaw",
        name: ".openclaw",
        path: "/home/ubuntu/.openclaw",
        category: "workspace",
    },
    {
        key: "mira-dashboard",
        name: "mira-dashboard",
        path: dashboardProjectPaths.productionCheckoutRoot,
        category: "project",
    },
    {
        key: "docker",
        name: "docker",
        path: "/opt/docker",
        category: "infra",
    },
];

async function safeGit(repoPath: string, arguments_: string[]) {
    try {
        return {
            isOk: true,
            output: await runCacheCommand("git", ["-C", repoPath, ...arguments_]),
        };
    } catch (error) {
        return { isOk: false, output: errorMessage(error) };
    }
}

function summarizeStatus(lines: string[]) {
    const chars = lines.map((line) => ({
        index: line[0] ?? " ",
        workTree: line[1] ?? " ",
        line,
    }));
    const unmergedStatuses = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
    return {
        staged: chars.filter(
            ({ index, workTree }) =>
                index !== " " &&
                index !== "?" &&
                !unmergedStatuses.has(`${index}${workTree}`)
        ).length,
        modified: chars.filter(({ workTree }) => workTree === "M").length,
        deleted: chars.filter(({ index, workTree }) => index === "D" || workTree === "D")
            .length,
        untracked: chars.filter(({ line }) => line.startsWith("??")).length,
        renamed: chars.filter(({ index, workTree }) => index === "R" || workTree === "R")
            .length,
        conflicted: chars.filter(
            ({ index, workTree }) =>
                unmergedStatuses.has(`${index}${workTree}`) ||
                index === "U" ||
                workTree === "U"
        ).length,
        total: lines.length,
    };
}

function emptyStatusSummary(): ReturnType<typeof summarizeStatus> {
    return summarizeStatus([]);
}

function sanitizeRemoteUrl(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        const url = new URL(value);
        url.username = "";
        url.password = "";
        url.search = "";
        url.hash = "";
        return url.href;
    } catch {
        const withoutQuery = value.replace(/\?.*$/u, "");
        const scpStyleMatch = withoutQuery.match(/^([^@\s]+)@([^:\s]+:.+)$/u);
        if (scpStyleMatch) {
            return scpStyleMatch[2];
        }
        return withoutQuery.replace(/\/\/[^/@\s]+@/u, "//");
    }
}

export async function refreshGitCache() {
    const repos = [];
    for (const repo of gitRepos) {
        const inside = await safeGit(repo.path, ["rev-parse", "--is-inside-work-tree"]);
        if (!inside.isOk) {
            repos.push({
                ...repo,
                exists: false,
                dirty: false,
                error: inside.output,
                statusSummary: emptyStatusSummary(),
            });
            continue;
        }
        if (inside.output.trim() !== "true") {
            repos.push({
                ...repo,
                exists: false,
                dirty: false,
                error: "Not a git repository",
                statusSummary: emptyStatusSummary(),
            });
            continue;
        }
        const [branch, head, remote, statusShort] = await Promise.all([
            safeGit(repo.path, ["branch", "--show-current"]),
            safeGit(repo.path, ["rev-parse", "HEAD"]),
            safeGit(repo.path, ["remote", "-v"]),
            safeGit(repo.path, ["status", "--short"]),
        ]);
        const porcelain = statusShort.isOk
            ? statusShort.output.split("\n").filter(Boolean)
            : [];
        const statusSummary = statusShort.isOk
            ? summarizeStatus(porcelain)
            : emptyStatusSummary();
        const isDirty = statusShort.isOk ? statusSummary.total > 0 : true;
        repos.push({
            ...repo,
            exists: true,
            branch: branch.isOk ? branch.output || undefined : undefined,
            head: head.isOk ? head.output || undefined : undefined,
            remote: remote.isOk
                ? sanitizeRemoteUrl(remote.output.split(/\s+/u, 2)[1] || undefined)
                : undefined,
            dirty: isDirty,
            statusSummary,
            statusShort: porcelain.slice(0, 25),
            statusTruncated: porcelain.length > 25,
            ...(!statusShort.isOk && { statusError: statusShort.output }),
            checkedAt: nowIso(),
        });
    }
    const dirtyRepos = repos.filter((repo) => repo.dirty).map((repo) => repo.key);
    const missingRepos = repos
        .filter((repo) => repo.exists === false)
        .map((repo) => repo.key);
    const payload = {
        repos,
        dirtyRepos,
        dirtyCount: dirtyRepos.length,
        missingRepos,
        checkedAt: nowIso(),
    };
    writeCacheSuccess({
        key: "git.workspace",
        data: payload,
        source: "backend",
        ttl: 24,
        ttlUnit: "hours",
        metadata: {
            workflow: "Cache Foundation - Git Workspace",
            summary: {
                repoCount: repos.length,
                dirtyCount: dirtyRepos.length,
                dirtyRepos,
                missingRepos,
            },
        },
    });
    return { refreshed: ["git.workspace"] };
}
