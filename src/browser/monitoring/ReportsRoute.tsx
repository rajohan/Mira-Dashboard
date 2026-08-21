import { ReportBrowser } from "./ReportBrowser.tsx";
import { useReportRealtimeInvalidation } from "./useMonitoringRealtimeInvalidation.ts";

/** @returns Immutable monitoring reports with exact detail and deletion flows. */
export function ReportsRoute() {
    useReportRealtimeInvalidation();

    return <ReportBrowser />;
}
