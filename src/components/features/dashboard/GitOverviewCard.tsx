import { GitBranch, GitCommitHorizontal } from "lucide-react";

import { useCacheEntry } from "../../../hooks/useCache";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

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

interface GitWorkspaceCache {
    repos: GitRepoSummary[];
    dirtyRepos: string[];
    dirtyCount: number;
    missingRepos: string[];
    checkedAt: string;
}

export function GitOverviewCard() {
    const { data, isLoading, isError } = useCacheEntry<GitWorkspaceCache>(
        "git.workspace",
        60_000
    );

    const git = data?.data;
    const repos = git?.repos || [];
    const dirtyRepos = repos.filter((repo) => repo.dirty);

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Git workspace
                </h3>
                <GitBranch className="h-4 w-4 text-primary-400" />
            </div>

            {isLoading ? (
                <div className="text-sm text-primary-300">Loading git cache…</div>
            ) : isError || !git ? (
                <div className="text-sm text-rose-300">Git cache unavailable.</div>
            ) : (
                <div className="space-y-3 text-sm text-primary-200">
                    <div className="flex items-center justify-between">
                        <span>Repos tracked</span>
                        <span className="font-semibold text-primary-50">{repos.length}</span>
                    </div>

                    <div className="flex items-center justify-between">
                        <span>Dirty repos</span>
                        <span className={dirtyRepos.length > 0 ? "font-semibold text-yellow-300" : "font-semibold text-green-300"}>
                            {dirtyRepos.length}
                        </span>
                    </div>

                    <div className="space-y-2">
                        {repos.map((repo) => (
                            <div
                                key={repo.key}
                                className="rounded-lg border border-primary-700 bg-primary-800/40 px-3 py-2"
                            >
                                <div className="mb-1 flex items-center justify-between gap-2">
                                    <div className="inline-flex items-center gap-2 text-sm text-primary-100">
                                        <GitCommitHorizontal className="h-3.5 w-3.5 text-primary-400" />
                                        <span>{repo.name}</span>
                                    </div>
                                    <Badge variant={repo.dirty ? "warning" : "success"}>
                                        {repo.dirty ? "Dirty" : "Clean"}
                                    </Badge>
                                </div>
                                <div className="text-xs text-primary-400">
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
