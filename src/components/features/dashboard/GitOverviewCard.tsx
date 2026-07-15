import { ExternalLink, GitBranch, GitCommitHorizontal } from "lucide-react";

import { useCacheEntry } from "../../../hooks/useCache";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

const DEFAULT_BRANCH = "main";

/** Represents Git repo summary. */
interface GitRepoSummary {
    key: string;
    name: string;
    exists?: boolean;
    branch: string | undefined;
    remote: string | undefined;
    dirty: boolean;
    statusSummary: {
        staged: number;
        modified: number;
        deleted: number;
        untracked: number;
        renamed: number;
        conflicted: number;
        total: number;
    };
}

/** Represents Git workspace cache. */
interface GitWorkspaceCache {
    repos: GitRepoSummary[];
    dirtyRepos: string[];
    dirtyCount: number;
    missingRepos: string[];
    checkedAt: string;
}

function isGitWorkspaceCache(value: unknown): value is GitWorkspaceCache {
    if (!value || typeof value !== "object") return false;
    const candidate = value as Partial<GitWorkspaceCache>;
    return Array.isArray(candidate.repos) && Array.isArray(candidate.missingRepos);
}

function repoUrlFromRemote(remote: string | undefined): string | undefined {
    if (!remote) {
        return undefined;
    }
    const trimmedRemote = remote.trim().replace(/\.git$/u, "");
    if (!trimmedRemote) {
        return undefined;
    }
    if (trimmedRemote.startsWith("https://github.com/")) {
        return trimmedRemote;
    }

    const scpStyleMatch = trimmedRemote.match(/^github\.com:(?<path>[^/\s]+\/[^/\s]+)$/u);
    if (scpStyleMatch?.groups?.path) {
        return `https://github.com/${scpStyleMatch.groups.path}`;
    }

    return undefined;
}

/** Renders the Git overview card UI. */
export function GitOverviewCard() {
    const { data, isLoading } = useCacheEntry<GitWorkspaceCache>("git.workspace", 60_000);

    const git = isGitWorkspaceCache(data?.data) ? data.data : undefined;
    const repos = git?.repos || [];
    const dirtyRepos = repos.filter((repo) => repo.dirty);
    const offMainRepos = repos.filter(
        (repo) => repo.exists !== false && repo.branch && repo.branch !== DEFAULT_BRANCH
    );

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Git workspace
                </h3>
                <GitBranch className="size-4 text-primary-400" />
            </div>

            {isLoading ? (
                <div className="text-sm text-primary-300">Loading git cache…</div>
            ) : git === undefined ? (
                <div className="text-sm text-rose-300">Git cache unavailable.</div>
            ) : (
                <div className="space-y-3 text-sm text-primary-200">
                    <div className="flex items-center justify-between">
                        <span>Repos tracked</span>
                        <span className="font-semibold text-primary-50">
                            {repos.length}
                        </span>
                    </div>

                    <div className="flex items-center justify-between">
                        <span>Dirty repos</span>
                        <span
                            className={
                                dirtyRepos.length > 0
                                    ? "font-semibold text-yellow-300"
                                    : "font-semibold text-green-300"
                            }
                        >
                            {dirtyRepos.length}
                        </span>
                    </div>

                    <div className="flex items-center justify-between">
                        <span>Missing repos</span>
                        <span
                            className={
                                git.missingRepos.length > 0
                                    ? "font-semibold text-red-300"
                                    : "font-semibold text-green-300"
                            }
                        >
                            {git.missingRepos.length}
                        </span>
                    </div>

                    <div className="flex items-center justify-between">
                        <span>Repos off main</span>
                        <span
                            className={
                                offMainRepos.length > 0
                                    ? "font-semibold text-yellow-300"
                                    : "font-semibold text-green-300"
                            }
                        >
                            {offMainRepos.length}
                        </span>
                    </div>

                    <div className="space-y-2">
                        {repos.map((repo) => (
                            <GitRepoRow key={repo.key} repo={repo} />
                        ))}
                    </div>
                </div>
            )}
        </Card>
    );
}

function GitRepoRow({ repo }: { repo: GitRepoSummary }) {
    const repoUrl = repoUrlFromRemote(repo.remote);
    const isMissing = repo.exists === false;

    return (
        <div className="rounded-lg border border-primary-700 bg-primary-800/40 px-3 py-2">
            <div className="mb-1 flex items-start justify-between gap-2">
                <div className="inline-flex min-w-0 items-center gap-2 text-sm text-primary-100">
                    <GitCommitHorizontal className="size-3.5 shrink-0 text-primary-400" />
                    {repoUrl ? (
                        <a
                            href={repoUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex min-w-0 items-center gap-1 truncate transition-colors hover:text-primary-50"
                            aria-label={`Open ${repo.name} on GitHub`}
                        >
                            <span className="truncate">{repo.name}</span>
                            <ExternalLink className="size-3 shrink-0" />
                        </a>
                    ) : (
                        <span className="truncate">{repo.name}</span>
                    )}
                </div>
                <div className="flex shrink-0 flex-wrap justify-end gap-1">
                    {!isMissing && repo.branch && repo.branch !== DEFAULT_BRANCH ? (
                        <Badge variant="warning">Off main</Badge>
                    ) : undefined}
                    <Badge
                        variant={isMissing ? "error" : repo.dirty ? "warning" : "success"}
                    >
                        {isMissing ? "Missing" : repo.dirty ? "Dirty" : "Clean"}
                    </Badge>
                </div>
            </div>
            <div className="text-xs wrap-break-word text-primary-400">
                {isMissing ? "repository unavailable" : repo.branch || "unknown branch"}
                {isMissing
                    ? undefined
                    : repo.statusSummary.total > 0
                      ? ` · ${repo.statusSummary.total} change${repo.statusSummary.total === 1 ? "" : "s"}`
                      : " · no changes"}
            </div>
        </div>
    );
}
