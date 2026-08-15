import { useState } from "react";

import type { OpenClawCronJob } from "../../contracts/openClawCron.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { StretchedAction } from "../ui/StretchedAction.tsx";
import { Text } from "../ui/Text.tsx";
import {
    openClawCronRunStatusLabel,
    openClawCronScheduleLabel,
    openClawCronSynchronizationLabel,
} from "./presentation.ts";

interface OpenClawCronTableProps {
    readonly jobs: readonly OpenClawCronJob[];
    readonly onSelect: (id: string) => void;
    readonly selectedId?: string;
}

function synchronizationVariant(state: OpenClawCronJob["synchronization"]["state"]) {
    if (state === "confirmed") return "success" as const;
    if (state === "pending") return "warning" as const;
    return "danger" as const;
}

function dateTime(timestampMs: number | undefined) {
    if (timestampMs === undefined) return "—";
    return (
        <time dateTime={new Date(timestampMs).toISOString()}>
            {formatDashboardDateTime(timestampMs)}
        </time>
    );
}

function definitionLabel(label: string) {
    return (
        <dt className="text-primary-400 text-xs font-medium tracking-wide uppercase">
            {label}
        </dt>
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
    selectedId,
}: OpenClawCronTableProps) {
    const [hoveredId, setHoveredId] = useState<string>();

    return (
        <ul
            aria-label="OpenClaw scheduled jobs"
            className="grid max-w-full min-w-0 grid-cols-1 gap-3"
        >
            {jobs.map((job) => {
                const selected = job.id === selectedId;
                const hovered = job.id === hoveredId;
                return (
                    <li
                        className={cn(
                            "group relative max-w-full min-w-0 rounded-lg border p-3 transition-colors sm:p-4",
                            inventoryCardSurface(selected, hovered)
                        )}
                        key={job.id}
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
                            <div className="flex max-w-full min-w-0 items-start justify-between gap-2">
                                <p className="text-primary-100 group-focus-within:text-accent-300 group-hover:text-accent-300 min-w-0 text-left font-medium wrap-anywhere">
                                    {job.name}
                                </p>
                                {selected && <Badge variant="info">Selected</Badge>}
                            </div>
                            <Text
                                className="mt-1 max-w-full font-mono wrap-anywhere"
                                size="sm"
                                tone="muted"
                            >
                                {job.id}
                            </Text>
                        </div>

                        <dl className="mt-4 grid max-w-full min-w-0 grid-cols-1 gap-x-5 gap-y-3 sm:grid-cols-2">
                            <div className="min-w-0">
                                {definitionLabel("OpenClaw status")}
                                <dd className="mt-1">
                                    <Badge variant={job.enabled ? "success" : "default"}>
                                        {job.enabled ? "enabled" : "disabled"}
                                    </Badge>
                                </dd>
                            </div>
                            <div className="min-w-0">
                                {definitionLabel("Dashboard status")}
                                <dd className="mt-1">
                                    <Badge
                                        variant={synchronizationVariant(
                                            job.synchronization.state
                                        )}
                                    >
                                        {openClawCronSynchronizationLabel(
                                            job.synchronization.state
                                        )}
                                    </Badge>
                                </dd>
                            </div>
                            <div className="min-w-0 sm:col-span-2">
                                {definitionLabel("Schedule")}
                                <dd className="text-primary-100 mt-1 max-w-full font-mono text-xs wrap-anywhere">
                                    {openClawCronScheduleLabel(job)}
                                </dd>
                            </div>
                            <div className="min-w-0">
                                {definitionLabel("Last run")}
                                <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                    {dateTime(job.state.lastRunAtMs)}
                                </dd>
                            </div>
                            <div className="min-w-0">
                                {definitionLabel("Next run")}
                                <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                    {dateTime(job.state.nextRunAtMs)}
                                </dd>
                            </div>
                            <div className="min-w-0 sm:col-span-2">
                                {definitionLabel("Last status")}
                                <dd className="text-primary-100 mt-1 text-sm wrap-anywhere">
                                    {job.state.lastRunStatus === undefined
                                        ? "—"
                                        : openClawCronRunStatusLabel(
                                              job.state.lastRunStatus
                                          )}
                                </dd>
                            </div>
                        </dl>
                    </li>
                );
            })}
        </ul>
    );
}
