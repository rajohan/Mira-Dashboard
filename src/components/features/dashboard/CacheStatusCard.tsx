import { Loader2, RefreshCw } from "lucide-react";

import { useCacheHeartbeat, useRefreshCacheEntry } from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

interface CacheStatusCardItem {
    key: string;
    label: string;
    description?: string;
    refreshKeys?: string[];
}

interface CacheStatusCardProps {
    title: string;
    items: CacheStatusCardItem[];
}

function getVariant(status?: string): "success" | "warning" | "error" | "default" {
    if (status === "fresh") return "success";
    if (status === "stale") return "warning";
    if (status === "error") return "error";
    return "default";
}

export function CacheStatusCard({ title, items }: CacheStatusCardProps) {
    const { data } = useCacheHeartbeat(30_000);
    const refreshCache = useRefreshCacheEntry();

    const entries = items.map((item) => ({
        item,
        entry: data?.entries.find((entry) => entry.key === item.key),
    }));

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    {title}
                </h3>
            </div>

            <div className="max-h-[400px] space-y-3 overflow-y-auto pr-2">
                {entries.map(({ item, entry }) => {
                    const refreshKeys =
                        item.refreshKeys && item.refreshKeys.length > 0
                            ? item.refreshKeys
                            : [item.key];
                    const refreshToken = refreshKeys.join(",");
                    const isRefreshing =
                        refreshCache.isPending && refreshCache.variables === refreshToken;

                    return (
                        <div
                            key={item.key}
                            className="rounded-lg border border-primary-700 bg-primary-900/30 p-3"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="text-sm font-medium text-primary-100">
                                        {item.label}
                                    </div>
                                    <div className="mt-1 text-xs text-primary-400">
                                        {item.description || item.key}
                                    </div>
                                </div>
                                <Badge variant={getVariant(entry?.status)}>
                                    {entry?.status || "missing"}
                                </Badge>
                            </div>

                            <div className="mt-3 flex flex-col gap-3 text-xs text-primary-300 sm:flex-row sm:items-center sm:justify-between">
                                <div className="min-w-0">
                                    <div>
                                        Last update:{" "}
                                        <span className="text-primary-100">
                                            {entry?.updatedAt
                                                ? formatDate(new Date(entry.updatedAt))
                                                : "Never"}
                                        </span>
                                    </div>
                                    {entry?.errorMessage ? (
                                        <div
                                            className="mt-1 truncate text-rose-300"
                                            title={entry.errorMessage}
                                        >
                                            {entry.errorMessage}
                                        </div>
                                    ) : null}
                                </div>
                                <button
                                    type="button"
                                    className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-primary-600 px-2 py-1 text-primary-100 transition hover:border-primary-400 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                                    disabled={isRefreshing}
                                    onClick={() => refreshCache.mutate(refreshToken)}
                                >
                                    {isRefreshing ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    ) : (
                                        <RefreshCw className="h-3.5 w-3.5" />
                                    )}
                                    Force update
                                </button>
                            </div>
                        </div>
                    );
                })}
            </div>
        </Card>
    );
}
