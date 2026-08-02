import type { ScheduledJob } from "../../../../../contracts/jobs/scheduled";
import { formatDate } from "../../../utils/format";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";
import {
    formatScheduledJobSchedule,
    scheduledJobStatusLabel,
    scheduledJobStatusVariant,
} from "./scheduledJobPresentation";

interface ScheduledJobListProperties {
    jobs: ScheduledJob[];
    selectedId: string;
    currentJobId: string;
    onSelect: (id: string) => void;
}

export function ScheduledJobList({
    jobs,
    selectedId,
    currentJobId,
    onSelect,
}: ScheduledJobListProperties) {
    return (
        <Card
            variant="bordered"
            className="flex min-w-0 flex-col p-0 xl:max-h-[calc(100vh-10rem)]"
        >
            <div className="border-b border-primary-700 px-3 py-2 text-sm font-semibold text-primary-200 sm:px-4 sm:py-3">
                Dashboard jobs
            </div>
            <div className="min-h-0 flex-1 overflow-visible p-2 xl:overflow-auto">
                {jobs.map((job) => {
                    const isSelected =
                        job.id === selectedId || (!selectedId && job.id === currentJobId);
                    return (
                        <Button
                            key={job.id}
                            type="button"
                            variant="ghost"
                            onClick={() => onSelect(job.id)}
                            className={[
                                "mb-2 w-full min-w-0 flex-col items-stretch justify-start rounded-lg border px-3 py-2 text-left transition",
                                isSelected
                                    ? "border-accent-500 bg-accent-500/10"
                                    : "border-primary-700 bg-primary-800/40 hover:border-primary-500",
                            ].join(" ")}
                        >
                            <div className="flex w-full min-w-0 items-start justify-between gap-2">
                                <div className="min-w-0">
                                    <div className="truncate text-sm font-medium text-primary-100">
                                        {job.name}
                                    </div>
                                    <div className="mt-1 truncate text-xs text-primary-400">
                                        {job.id}
                                    </div>
                                </div>
                                <Badge
                                    className="shrink-0 whitespace-nowrap"
                                    variant={scheduledJobStatusVariant(job)}
                                >
                                    {scheduledJobStatusLabel(job)}
                                </Badge>
                            </div>
                            <div className="mt-2 grid w-full grid-cols-1 gap-x-2 gap-y-1 text-[11px] text-primary-400 sm:grid-cols-2">
                                <span>Schedule: {formatScheduledJobSchedule(job)}</span>
                                <span>
                                    Next:{" "}
                                    {job.nextRunAt
                                        ? formatDate(job.nextRunAt)
                                        : "Not scheduled"}
                                </span>
                            </div>
                        </Button>
                    );
                })}
            </div>
        </Card>
    );
}
