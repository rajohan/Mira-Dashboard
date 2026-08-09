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
                description="Daily briefs, summaries, heartbeats, and custom immutable monitoring documents. Updates automatically from report events, with 30-second safety polling if realtime disconnects."
                eyebrow="Monitoring"
                title="Reports"
            />
            <div className="mt-8">
                <ReportBrowser />
            </div>
        </div>
    );
}
