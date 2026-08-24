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
                description="Active and resolved incident generations produced by complete monitoring snapshots. Updates automatically from incident events, with 30-second safety polling if realtime disconnects."
                eyebrow="Monitoring"
                title="Incidents"
            />
            <div className="mt-8">
                <IncidentBrowser />
            </div>
        </div>
    );
}
