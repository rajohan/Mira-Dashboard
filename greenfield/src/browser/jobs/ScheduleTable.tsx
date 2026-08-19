import { useState } from "react";

import type { JobRunState, ScheduleSummary } from "../../contracts/jobModel.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { StretchedAction } from "../ui/StretchedAction.tsx";
import { Text } from "../ui/Text.tsx";
import { scheduleConfigurationLabel } from "./schedulePresentation.ts";

function runStateVariant(state: JobRunState) {
    if (["failed", "timed-out"].includes(state)) return "danger" as const;
    if (state === "succeeded") return "success" as const;
    if (["queued", "running"].includes(state)) return "info" as const;
    return "default" as const;
}

function cardSurface(selected: boolean, hovered: boolean): string {
    if (selected) {
        return "border-accent-400 bg-accent-500/20 ring-accent-300/40 ring-1 ring-inset";
    }
    if (hovered) return "border-primary-500 bg-primary-800/55";
    return "border-primary-700 bg-primary-900/40";
}

interface ScheduleTableProps {
    readonly onSelect: (id: string) => void;
    readonly schedules: readonly ScheduleSummary[];
    readonly selectedId?: string;
}

/** @returns Compact selectable Dashboard schedule inventory matching the legacy layout. */
export function ScheduleTable({ onSelect, schedules, selectedId }: ScheduleTableProps) {
    const [hoveredId, setHoveredId] = useState<string>();

    return (
        <ul aria-label="Dashboard schedules" className="grid min-w-0 grid-cols-1 gap-2">
            {schedules.map((schedule) => {
                const selected = schedule.id === selectedId;
                const activeState = schedule.activeRun?.state;
                return (
                    <li
                        className={cn(
                            "group relative min-w-0 rounded-lg border px-3 py-2 transition-colors",
                            cardSurface(selected, schedule.id === hoveredId)
                        )}
                        key={schedule.id}
                    >
                        <StretchedAction
                            aria-current={selected ? "true" : undefined}
                            className="z-10 focus-visible:ring-inset"
                            label={`${schedule.name}; ${schedule.id}`}
                            onClick={() => onSelect(schedule.id)}
                            onPointerEnter={() => setHoveredId(schedule.id)}
                            onPointerLeave={() =>
                                setHoveredId((current) =>
                                    current === schedule.id ? undefined : current
                                )
                            }
                        />
                        <div className="flex min-w-0 items-start justify-between gap-2">
                            <div className="min-w-0">
                                <p className="text-primary-100 group-focus-within:text-accent-300 group-hover:text-accent-300 truncate text-sm font-medium">
                                    {schedule.name}
                                </p>
                                <Text className="mt-1 truncate" size="sm" tone="muted">
                                    {schedule.id}
                                </Text>
                            </div>
                            <div className="flex shrink-0 items-center gap-1">
                                <Badge variant={schedule.enabled ? "success" : "default"}>
                                    {schedule.enabled ? "Enabled" : "Disabled"}
                                </Badge>
                                {activeState !== undefined && (
                                    <Badge variant={runStateVariant(activeState)}>
                                        {activeState}
                                    </Badge>
                                )}
                            </div>
                        </div>
                        <dl className="text-primary-400 mt-2 grid min-w-0 grid-cols-1 gap-x-2 gap-y-1 text-[11px] sm:grid-cols-2 xl:grid-cols-1 2xl:grid-cols-2">
                            <div className="flex min-w-0 gap-1">
                                <dt>Schedule:</dt>
                                <dd className="min-w-0 truncate font-mono">
                                    {scheduleConfigurationLabel(schedule.schedule)}
                                </dd>
                            </div>
                            <div className="flex min-w-0 gap-1">
                                <dt>Next:</dt>
                                <dd className="min-w-0 truncate">
                                    {schedule.nextRunAtMs === undefined
                                        ? "Paused"
                                        : formatDashboardDateTime(schedule.nextRunAtMs)}
                                </dd>
                            </div>
                        </dl>
                    </li>
                );
            })}
        </ul>
    );
}
