import { Loader2, RefreshCw } from "lucide-react";

import { useCacheHeartbeat, useRefreshCacheEntry } from "../../../hooks";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

/** Describes cache status card item. */
interface CacheStatusCardItem {
    key: string;
    label: string;
    description?: string;
    refreshKeys?: string[];
}

/** Describes cache status card props. */
interface CacheStatusCardProps {
    title: string;
    items: CacheStatusCardItem[];
}

/** Handles get variant. */
function getVariant(status?: string): "success" | "warning" | "error" | "default" {
    if (status === "fresh") return "success";
    if (status === "stale") return "warning";
    if (status === "error") return "error";
    return "default";
}

/** Renders the cache status card UI. */
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
                <h3 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
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
                            className="border-primary-700 bg-primary-900/30 rounded-lg border p-3"
                        >
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0 flex-1">
                                    <div className="text-primary-100 text-sm font-medium">
                                        {item.label}
                                    </div>
                                    <div className="text-primary-400 mt-1 text-xs">
                                        {item.description || item.key}
                                    </div>
                                </div>
                                <Badge variant={getVariant(entry?.status)}>
                                    {entry?.status || "missing"}
                                </Badge>
                            </div>

                            <div className="text-primary-300 mt-3 flex flex-col gap-3 text-xs sm:flex-row sm:items-center sm:justify-between">
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
                                    className="border-primary-600 text-primary-100 hover:border-primary-400 inline-flex w-full items-center justify-center gap-1 rounded-md border px-2 py-1 transition disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto"
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
