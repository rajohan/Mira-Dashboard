import { Link } from "@tanstack/react-router";
import { Clock3 } from "lucide-react";

import { useCronJobs } from "../../../hooks";
import { Card } from "../../ui/Card";

export function CronOverviewCard() {
    const { data: jobs = [] } = useCronJobs();

    const enabledCount = jobs.filter((job) => job.enabled !== false).length;
    const disabledCount = jobs.length - enabledCount;

    return (
        <Card>
            <div className="mb-3 flex items-center justify-between">
                <h3 className="text-sm font-semibold uppercase tracking-wide text-primary-300">
                    Cron jobs
                </h3>
                <Clock3 className="h-4 w-4 text-primary-400" />
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
            </div>

            <Link
                to="/cron"
                className="mt-4 inline-flex rounded-md border border-primary-600 px-3 py-1.5 text-xs text-primary-200 transition hover:border-primary-500 hover:text-primary-50"
            >
                Open cron management
            </Link>
        </Card>
    );
}
