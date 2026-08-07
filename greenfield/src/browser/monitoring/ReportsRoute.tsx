import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, ShieldAlert } from "lucide-react";

import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { refreshReportQueries } from "./monitoringQueries.ts";
import { ReportBrowser } from "./ReportBrowser.tsx";
import { useReportRealtimeInvalidation } from "./useMonitoringRealtimeInvalidation.ts";

/** @returns Immutable monitoring reports with exact detail and deletion flows. */
export function ReportsRoute() {
    useReportRealtimeInvalidation();
    const queryClient = useQueryClient();
    const refresh = useExclusiveDashboardAction();

    return (
        <div>
            <PageHeader
                actions={
                    <div className="flex flex-wrap gap-2">
                        <ActionLink size="sm" to="/incidents" variant="secondary">
                            <Icon icon={ShieldAlert} size="sm" tone="inherit" />
                            Browse incidents
                        </ActionLink>
                        <Button
                            busy={refresh.busy}
                            busyLabel="Refreshing…"
                            onClick={() =>
                                void refresh.run(() => refreshReportQueries(queryClient))
                            }
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Refresh
                        </Button>
                    </div>
                }
                description="Daily briefs, summaries, heartbeats, and custom immutable monitoring documents."
                eyebrow="Monitoring"
                title="Reports"
            />
            <Alert className="mt-5" message={refresh.error} />
            <div className="mt-8">
                <ReportBrowser />
            </div>
        </div>
    );
}
