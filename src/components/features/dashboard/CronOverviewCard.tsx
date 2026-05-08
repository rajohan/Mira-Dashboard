import { Clock3 } from "lucide-react";

import { useCronJobs } from "../../../hooks";
import {
    formatCronLastStatus,
    formatCronTimestamp,
    getCronJobName,
    getCronStateValue,
    getCronStatusVariant,
} from "../../../utils/cronUtils";
import { Badge } from "../../ui/Badge";
import { Card } from "../../ui/Card";

export function CronOverviewCard() {
    const { data: jobs = [] } = useCronJobs();

    const enabledCount = jobs.filter((job) => job.enabled !== false).length;
    const disabledCount = jobs.length - enabledCount;

    const latestRunJob =
        [...jobs]
            .filter((job) => typeof getCronStateValue(job, "lastRunAtMs") === "number")
            .sort(
                (a, b) =>
                    (Number(getCronStateValue(b, "lastRunAtMs")) || 0) -
                    (Number(getCronStateValue(a, "lastRunAtMs")) || 0)
            )[0] || null;

    const nextRunJob =
        [...jobs]
            .filter((job) => typeof getCronStateValue(job, "nextRunAtMs") === "number")
            .sort(
                (a, b) =>
                    (Number(getCronStateValue(a, "nextRunAtMs")) || 0) -
                    (Number(getCronStateValue(b, "nextRunAtMs")) || 0)
            )[0] || null;

    const lastStatus = formatCronLastStatus(
        latestRunJob ? getCronStateValue(latestRunJob, "lastRunStatus") : undefined
    );

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-primary-300 text-sm font-semibold tracking-wide uppercase">
                    Cron jobs
                </h3>
                <Clock3 className="text-primary-400 h-4 w-4" />
            </div>

            <div className="text-primary-200 space-y-2 text-sm">
                <div className="flex items-center justify-between">
                    <span>Total</span>
                    <span className="text-primary-50 font-semibold">{jobs.length}</span>
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
                    <span className="text-primary-100 min-w-0 truncate text-right">
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
                    <span className="text-primary-100 min-w-0 truncate text-right">
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
