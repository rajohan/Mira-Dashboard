import { ShieldAlert } from "lucide-react";

import { ActionLink } from "../ui/ActionLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { ReportBrowser } from "./ReportBrowser.tsx";
import { useReportRealtimeInvalidation } from "./useMonitoringRealtimeInvalidation.ts";

/** @returns Immutable monitoring reports with exact detail and deletion flows. */
export function ReportsRoute() {
    useReportRealtimeInvalidation();

    return (
        <div>
            <PageHeader
                actions={
                    <ActionLink size="sm" to="/incidents" variant="secondary">
                        <Icon icon={ShieldAlert} size="sm" tone="inherit" />
                        Browse incidents
                    </ActionLink>
                }
                description="Read daily briefs, summaries, health checks, and other monitoring reports. This page updates automatically and checks again every 30 seconds if live updates stop."
                eyebrow="Monitoring"
                title="Reports"
            />
            <div className="mt-8">
                <ReportBrowser />
            </div>
        </div>
    );
}
