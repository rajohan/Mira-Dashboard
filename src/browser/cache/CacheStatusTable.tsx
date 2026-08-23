import { DatabaseZap } from "lucide-react";

import type { CacheEntryStatus } from "../../contracts/cache.ts";
import { cn } from "../lib/classNames.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Text } from "../ui/Text.tsx";
import {
    cacheAttemptLabel,
    cacheAttemptVariant,
    cacheFreshnessLabel,
    cacheFreshnessVariant,
} from "./cachePresentation.ts";

interface CacheStatusTableProps {
    readonly entries: readonly CacheEntryStatus[];
    readonly onSelect: (key: string) => void;
    readonly selectedKey?: string;
}

/** @returns Compact, fully clickable cache-source inventory. */
export function CacheStatusTable({
    entries,
    onSelect,
    selectedKey,
}: CacheStatusTableProps) {
    return (
        <nav aria-label="Saved data sources" className="min-w-0">
            <ul className="max-h-176 space-y-2 overflow-y-auto pr-1">
                {entries.map((entry) => {
                    const selected = entry.key === selectedKey;
                    return (
                        <li key={entry.key}>
                            <Button
                                aria-current={selected ? "true" : undefined}
                                aria-label={`View ${entry.key}`}
                                className={cn(
                                    "border-primary-700 bg-primary-900/35 hover:bg-primary-800/65 focus-visible:ring-accent-300 flex w-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
                                    selected && "border-accent-500/60 bg-primary-800/70"
                                )}
                                onClick={() => onSelect(entry.key)}
                                type="button"
                                variant="unstyled"
                            >
                                <Icon
                                    className="mt-0.5 shrink-0"
                                    icon={DatabaseZap}
                                    size="md"
                                    tone="accent"
                                />
                                <span className="min-w-0 flex-1">
                                    <Text
                                        as="span"
                                        className="block truncate font-medium"
                                        size="sm"
                                    >
                                        {entry.key}
                                    </Text>
                                    <span className="mt-2 flex flex-wrap gap-1.5">
                                        <Badge
                                            variant={cacheFreshnessVariant(
                                                entry.freshness
                                            )}
                                        >
                                            {cacheFreshnessLabel(entry.freshness)}
                                        </Badge>
                                        <Badge
                                            variant={cacheAttemptVariant(
                                                entry.lastAttemptStatus
                                            )}
                                        >
                                            {cacheAttemptLabel(entry.lastAttemptStatus)}
                                        </Badge>
                                    </span>
                                </span>
                            </Button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
