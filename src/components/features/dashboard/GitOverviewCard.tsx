import { GitBranch, GitCommitHorizontal } from "lucide-react";

import { useCacheEntry } from "../../../hooks/useCache";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

const DEFAULT_BRANCH = "main";

/** Represents git repo summary. */
interface GitRepoSummary {
    key: string;
    name: string;
    branch: string | null;
    remote: string | null;
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

/** Represents git workspace cache. */
interface GitWorkspaceCache {
    repos: GitRepoSummary[];
    dirtyRepos: string[];
    dirtyCount: number;
    missingRepos: string[];
    checkedAt: string;
}

/** Renders the git overview card UI. */
export function GitOverviewCard() {
    const { data, isLoading, isError } = useCacheEntry<GitWorkspaceCache>(
        "git.workspace",
        60_000
    );

    const git = data?.data;
    const repos = git?.repos || [];
    const dirtyRepos = repos.filter((repo) => repo.dirty);
    const offMainRepos = repos.filter(
        (repo) => repo.branch && repo.branch !== DEFAULT_BRANCH
    );

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Git workspace
                </h3>
                <GitBranch className="text-primary-400 h-4 w-4" />
            </div>

            {isLoading ? (
                <div className="text-primary-300 text-sm">Loading git cache…</div>
            ) : isError || !git ? (
                <div className="text-sm text-rose-300">Git cache unavailable.</div>
            ) : (
                <div className="text-primary-200 space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                        <span>Repos tracked</span>
                        <span className="text-primary-50 font-semibold">
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
                            <div
                                key={repo.key}
                                className="border-primary-700 bg-primary-800/40 rounded-lg border px-3 py-2"
                            >
                                <div className="mb-1 flex items-start justify-between gap-2">
                                    <div className="text-primary-100 inline-flex min-w-0 items-center gap-2 text-sm">
                                        <GitCommitHorizontal className="text-primary-400 h-3.5 w-3.5 shrink-0" />
                                        <span className="truncate">{repo.name}</span>
                                    </div>
                                    <div className="flex shrink-0 flex-wrap justify-end gap-1">
                                        {repo.branch && repo.branch !== DEFAULT_BRANCH ? (
                                            <Badge variant="warning">Off main</Badge>
                                        ) : null}
                                        <Badge
                                            variant={repo.dirty ? "warning" : "success"}
                                        >
                                            {repo.dirty ? "Dirty" : "Clean"}
                                        </Badge>
                                    </div>
                                </div>
                                <div className="text-primary-400 text-xs break-words">
                                    {repo.branch || "unknown branch"}
                                    {repo.statusSummary.total > 0
                                        ? ` · ${repo.statusSummary.total} change${repo.statusSummary.total === 1 ? "" : "s"}`
                                        : " · no changes"}
                                </div>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </Card>
    );
}
