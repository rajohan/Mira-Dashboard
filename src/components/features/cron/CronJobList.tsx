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

export function CronJobList({ jobs, selectedId, currentJobId, onSelect }: CronJobListProps) {
    return (
        <Card variant="bordered" className="p-0">
            <div className="border-b border-primary-700 px-4 py-3 text-sm font-semibold text-primary-200">
                Cron jobs
            </div>
            <div className="max-h-[70vh] overflow-auto p-2">
                {jobs.map((job) => {
                    const id = getCronJobId(job);
                    const isSelected = id === selectedId || (!selectedId && id === currentJobId);

                    return (
                        <Button
                            key={id}
                            type="button"
                            variant="ghost"
                            onClick={() => onSelect(id)}
                            className={[
                                "mb-2 w-full flex-col items-stretch justify-start rounded-lg border px-3 py-2 text-left transition",
                                isSelected
                                    ? "border-accent-500 bg-accent-500/10"
                                    : "border-primary-700 bg-primary-800/40 hover:border-primary-500",
                            ].join(" ")}
                        >
                            <div className="flex w-full items-center justify-between gap-2">
                                <div className="truncate text-sm font-medium text-primary-100">
                                    {getCronJobName(job)}
                                </div>
                                <Badge variant={job.enabled === false ? "warning" : "success"}>
                                    {job.enabled === false ? "Disabled" : "Enabled"}
                                </Badge>
                            </div>
                            <div className="mt-1 w-full truncate text-xs text-primary-400">{id}</div>
                            <div className="mt-2 grid w-full grid-cols-2 gap-x-2 gap-y-1 text-[11px] text-primary-400">
                                <span>
                                    Last: {formatCronTimestamp(getCronStateValue(job, "lastRunAtMs"))}
                                </span>
                                <span>
                                    Next: {formatCronTimestamp(getCronStateValue(job, "nextRunAtMs"))}
                                </span>
                            </div>
                        </Button>
                    );
                })}
            </div>
        </Card>
    );
}
