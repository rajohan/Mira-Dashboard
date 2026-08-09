import { Newspaper } from "lucide-react";

import { ActionLink } from "../ui/ActionLink.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { IncidentBrowser } from "./IncidentBrowser.tsx";
import { useIncidentRealtimeInvalidation } from "./useMonitoringRealtimeInvalidation.ts";

/** @returns Net-new incident generation reader linked from reports and notifications. */
export function IncidentsRoute() {
    useIncidentRealtimeInvalidation();

    return (
        <div>
            <PageHeader
                actions={
                    <ActionLink size="sm" to="/reports" variant="secondary">
                        <Icon icon={Newspaper} size="sm" tone="inherit" />
                        Browse reports
                    </ActionLink>
                }
                description="See current and resolved problems reported by monitoring. This page updates automatically and checks again every 30 seconds if live updates stop."
                eyebrow="Monitoring"
                title="Incidents"
            />
            <div className="mt-8">
                <IncidentBrowser />
            </div>
        </div>
    );
}
