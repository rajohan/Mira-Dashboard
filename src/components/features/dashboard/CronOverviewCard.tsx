import { Clock3 } from "lucide-react";

import { type CronJob, useCronJobs } from "../../../hooks";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
} from "../../../utils/cronUtilities";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

/** Returns finite cron timestamp values. */
function cronTimestamp(job: CronJob, key: "lastRunAtMs" | "nextRunAtMs") {
    const value = getCronStateValue(job, key);
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Renders the cron overview card UI. */
export function CronOverviewCard() {
    const { data: jobs = [] } = useCronJobs();

    const enabledCount = jobs.filter((job) => job.enabled !== false).length;
    const disabledCount = jobs.length - enabledCount;

    const latestRunJob =
        [...jobs]
            .filter((job) => cronTimestamp(job, "lastRunAtMs") !== undefined)
            .toSorted(
                (a, b) =>
                    cronTimestamp(b, "lastRunAtMs")! - cronTimestamp(a, "lastRunAtMs")!
            )[0] || undefined;

    const nextRunJob =
        [...jobs]
            .filter((job) => cronTimestamp(job, "nextRunAtMs") !== undefined)
            .toSorted(
                (a, b) =>
                    cronTimestamp(a, "nextRunAtMs")! - cronTimestamp(b, "nextRunAtMs")!
            )[0] || undefined;

    const lastStatus = formatCronLastStatus(
        latestRunJob ? getCronStateValue(latestRunJob, "lastRunStatus") : undefined
    );

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold tracking-wide text-primary-300 uppercase">
                    Cron jobs
                </h3>
                <Clock3 className="size-4 text-primary-400" />
            </div>

            <div className="space-y-2 text-sm text-primary-200">
                <div className="flex items-center justify-between">
                    <span>Total</span>
                    <span className="font-semibold text-primary-50">{jobs.length}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Enabled</span>
                    <span className="text-green-300">{enabledCount}</span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Disabled</span>
                    <span className="text-yellow-300">{disabledCount}</span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0">Last run</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {formatCronTimestamp(
                            latestRunJob
                                ? getCronStateValue(latestRunJob, "lastRunAtMs")
                                : undefined
                        )}
                        {latestRunJob ? ` (${getCronJobName(latestRunJob)})` : ""}
                    </span>
                </div>
                <div className="flex items-center justify-between gap-2">
                    <span className="shrink-0">Next run</span>
                    <span className="min-w-0 truncate text-right text-primary-100">
                        {formatCronTimestamp(
                            nextRunJob
                                ? getCronStateValue(nextRunJob, "nextRunAtMs")
                                : undefined
                        )}
                        {nextRunJob ? ` (${getCronJobName(nextRunJob)})` : ""}
                    </span>
                </div>
                <div className="flex items-center justify-between">
                    <span>Last status</span>
                    <Badge variant={getCronStatusVariant(lastStatus)}>{lastStatus}</Badge>
                </div>
            </div>
        </Card>
    );
}
