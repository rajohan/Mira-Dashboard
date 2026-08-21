import { IncidentBrowser } from "./IncidentBrowser.tsx";
import { useIncidentRealtimeInvalidation } from "./useMonitoringRealtimeInvalidation.ts";

/** @returns Net-new incident generation reader linked from reports and notifications. */
export function IncidentsRoute() {
    useIncidentRealtimeInvalidation();

    return <IncidentBrowser />;
}
