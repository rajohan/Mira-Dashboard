import { Loader2, RefreshCw } from "lucide-react";

import { useCacheHeartbeat, useRefreshCacheEntry } from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

/** Represents cache status card item. */
interface CacheStatusCardItem {
    key: string;
    label: string;
    description?: string;
    refreshKeys?: string[];
}

/** Provides props for cache status card. */
interface CacheStatusCardProperties {
    title: string;
    items: CacheStatusCardItem[];
}

/** Returns variant. */
function getVariant(status?: string): "success" | "warning" | "error" | "default" {
    if (status === "fresh") return "success";
    if (status === "stale") return "warning";
    if (status === "error") return "error";
    return "default";
}

function formatCacheUpdateTime(value?: string | undefined): string {
    if (!value) {
        return "Never";
    }

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
        return "Unknown";
    }

    return formatDate(date);
}

/** Renders the cache status card UI. */
export function CacheStatusCard({ title, items }: CacheStatusCardProperties) {
    const { data } = useCacheHeartbeat(30_000);
    const refreshCache = useRefreshCacheEntry();

    const entries = items.map((item) => ({
        item,
        entry: data?.entries.find((entry) => entry.key === item.key),
    }));

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    {title}
                </h3>
            </div>

            <div className="max-h-100 space-y-3 overflow-y-auto pr-2">
                {entries.map(({ item, entry }) => {
                    const refreshKeys =
                        item.refreshKeys && item.refreshKeys.length > 0
                            ? item.refreshKeys
                            : [item.key];
                    const refreshToken = refreshKeys.join(",");
                    const isRefreshing =
                        refreshCache.isPending && refreshCache.variables === refreshToken;
                    const refreshLabel = `Force update ${item.label}`;

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
                                            {formatCacheUpdateTime(entry?.updatedAt)}
                                        </span>
                                    </div>
                                    {entry?.errorMessage ? (
                                        <div
                                            className="mt-1 truncate text-rose-300"
                                            title={entry.errorMessage}
                                        >
                                            {entry.errorMessage}
                                        </div>
                                    ) : undefined}
                                </div>
                                <button
                                    type="button"
                                    aria-label={refreshLabel}
                                    className="inline-flex w-full items-center justify-center gap-1 rounded-md border border-primary-600 px-2 py-1 text-primary-100 transition hover:border-primary-400 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
                                    disabled={isRefreshing}
                                    onClick={() => refreshCache.mutate(refreshToken)}
                                    title={refreshLabel}
                                >
                                    {isRefreshing ? (
                                        <Loader2 className="size-3.5 animate-spin" />
                                    ) : (
                                        <RefreshCw className="size-3.5" />
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
