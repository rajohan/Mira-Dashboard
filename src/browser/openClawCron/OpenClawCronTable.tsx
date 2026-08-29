import { useState } from "react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import type { InfiniteScrollContinuation } from "../ui/InfiniteScrollTrigger.tsx";
import { StretchedAction } from "../ui/StretchedAction.tsx";
import { Text } from "../ui/Text.tsx";
import { VirtualizedList } from "../ui/VirtualizedList.tsx";
import {
    openClawCronRunStatusBadgeVariant,
    openClawCronRunStatusLabel,
} from "./presentation.ts";

interface OpenClawCronTableProps {
    readonly jobs: readonly OpenClawCronJob[];
    readonly onSelect: (id: string) => void;
    readonly pagination?: InfiniteScrollContinuation;
    readonly selectedId?: string;
}

function dateTime(timestampMs: number | undefined) {
    if (timestampMs === undefined) return "—";
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTime(timestampMs)}
        </time>
    );
}

function inventoryCardSurface(selected: boolean, hovered: boolean): string {
    if (selected) {
        return "border-accent-400 bg-accent-500/20 ring-accent-300/40 ring-1 ring-inset";
    }
    if (hovered) return "border-primary-500 bg-primary-800/55";
    return "border-primary-700 bg-primary-900/40";
}

/** @returns Accessible Gateway-owned cron inventory, explicitly separate from Dashboard jobs. */
export function OpenClawCronTable({
    jobs,
    onSelect,
    pagination,
    selectedId,
}: OpenClawCronTableProps) {
    const [hoveredId, setHoveredId] = useState<string>();

    return (
        <VirtualizedList
            className="h-full"
            constrainHeight={false}
            estimateSize={() => 112}
            getKey={(job) => job.id}
            itemClassName="pb-2"
            items={jobs}
            label="OpenClaw scheduled jobs"
            pagination={pagination}
            renderItem={(job) => {
                const selected = job.id === selectedId;
                const hovered = job.id === hoveredId;
                return (
                    <div
                        className={cn(
                            "group relative max-w-full min-w-0 rounded-lg border px-3 py-2 transition-colors",
                            inventoryCardSurface(selected, hovered)
                        )}
                    >
                        <StretchedAction
                            aria-current={selected ? "true" : undefined}
                            aria-pressed={selected}
                            className="z-10 focus-visible:ring-inset"
                            label={job.name}
                            onClick={() => onSelect(job.id)}
                            onPointerEnter={() => setHoveredId(job.id)}
                            onPointerLeave={() =>
                                setHoveredId((current) =>
                                    current === job.id ? undefined : current
                                )
                            }
                        />
                        <div className="max-w-full min-w-0">
                            <div className="flex max-w-full min-w-0 items-center justify-between gap-2">
                                <p className="text-primary-100 group-focus-within:text-accent-300 group-hover:text-accent-300 min-w-0 truncate text-left text-sm font-medium">
                                    {job.name}
                                </p>
                                <div className="flex shrink-0 items-center gap-1">
                                    <Badge variant={job.enabled ? "success" : "default"}>
                                        {job.enabled ? "Enabled" : "Disabled"}
                                    </Badge>
                                    {job.state.lastRunStatus !== undefined && (
                                        <Badge
                                            aria-label={`Last status: ${openClawCronRunStatusLabel(job.state.lastRunStatus)}`}
                                            variant={openClawCronRunStatusBadgeVariant(
                                                job.state.lastRunStatus
                                            )}
                                        >
                                            {openClawCronRunStatusLabel(
                                                job.state.lastRunStatus
                                            )}
                                        </Badge>
                                    )}
                                </div>
                            </div>
                            <Text
                                className="mt-1 max-w-full truncate"
                                size="sm"
                                tone="muted"
                            >
                                {job.id}
                            </Text>
                        </div>

                        <dl className="text-primary-400 mt-2 grid max-w-full min-w-0 grid-cols-1 gap-x-2 gap-y-1 text-[11px] sm:grid-cols-2">
                            <div className="flex min-w-0 gap-1">
                                <dt>Last:</dt>
                                <dd className="min-w-0 truncate">
                                    {dateTime(job.state.lastRunAtMs)}
                                </dd>
                            </div>
                            <div className="flex min-w-0 gap-1">
                                <dt>Next:</dt>
                                <dd className="min-w-0 truncate">
                                    {dateTime(job.state.nextRunAtMs)}
                                </dd>
                            </div>
                        </dl>
                    </div>
                );
            }}
        />
    );
}
