import type { CronJob } from "../../../hooks";
import {
    formatCronTimestamp,
    getCronJobId,
    getCronJobName,
    getCronStateValue,
} from "../../../utils/cronUtils";
import { Badge } from "../../ui/Badge";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/Card";

interface CronJobListProps {
    jobs: CronJob[];
    selectedId: string;
    currentJobId: string;
    onSelect: (id: string) => void;
}

export function CronJobList({
    jobs,
    selectedId,
    currentJobId,
    onSelect,
}: CronJobListProps) {
    return (
        <Card variant="bordered" className="min-w-0 p-0">
            <div className="border-primary-700 text-primary-200 border-b px-3 py-2 text-sm font-semibold sm:px-4 sm:py-3">
                Cron jobs
            </div>
            <div className="max-h-80 overflow-auto p-2 xl:max-h-[70vh]">
                {jobs.map((job) => {
                    const id = getCronJobId(job);
                    const isSelected =
                        id === selectedId || (!selectedId && id === currentJobId);

                    return (
                        <Button
                            key={id}
                            type="button"
                            variant="ghost"
                            onClick={() => onSelect(id)}
                            className={[
                                "mb-2 w-full min-w-0 flex-col items-stretch justify-start rounded-lg border px-3 py-2 text-left transition",
                                isSelected
                                    ? "border-accent-500 bg-accent-500/10"
                                    : "border-primary-700 bg-primary-800/40 hover:border-primary-500",
                            ].join(" ")}
                        >
                            <div className="flex w-full min-w-0 items-center justify-between gap-2">
                                <div className="text-primary-100 min-w-0 flex-1 truncate text-sm font-medium">
                                    {getCronJobName(job)}
                                </div>
                                <Badge
                                    className="shrink-0"
                                    variant={
                                        job.enabled === false ? "warning" : "success"
                                    }
                                >
                                    {job.enabled === false ? "Disabled" : "Enabled"}
                                </Badge>
                            </div>
                            <div className="text-primary-400 mt-1 w-full truncate text-xs">
                                {id}
                            </div>
                            <div className="text-primary-400 mt-2 grid w-full grid-cols-1 gap-x-2 gap-y-1 text-[11px] sm:grid-cols-2">
                                <span>
                                    Last:{" "}
                                    {formatCronTimestamp(
                                        getCronStateValue(job, "lastRunAtMs")
                                    )}
                                </span>
                                <span>
                                    Next:{" "}
                                    {formatCronTimestamp(
                                        getCronStateValue(job, "nextRunAtMs")
                                    )}
                                </span>
                            </div>
                        </Button>
                    );
                })}
            </div>
        </Card>
    );
}
