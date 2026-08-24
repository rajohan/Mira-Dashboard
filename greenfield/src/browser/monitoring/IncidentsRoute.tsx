import { useQueryClient } from "@tanstack/react-query";
import { Newspaper, RefreshCw } from "lucide-react";

import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PageHeader } from "../ui/PageHeader.tsx";
import { IncidentBrowser } from "./IncidentBrowser.tsx";
import { refreshIncidentQueries } from "./monitoringQueries.ts";
import { useIncidentRealtimeInvalidation } from "./useMonitoringRealtimeInvalidation.ts";

/** @returns Net-new incident generation reader linked from reports and notifications. */
export function IncidentsRoute() {
    useIncidentRealtimeInvalidation();
    const queryClient = useQueryClient();
    const refresh = useExclusiveDashboardAction();

    return (
        <div>
            <PageHeader
                actions={
                    <div className="flex flex-wrap gap-2">
                        <ActionLink size="sm" to="/reports" variant="secondary">
                            <Icon icon={Newspaper} size="sm" tone="inherit" />
                            Browse reports
                        </ActionLink>
                        <Button
                            busy={refresh.busy}
                            busyLabel="Refreshing…"
                            onClick={() =>
                                void refresh.run(() =>
                                    refreshIncidentQueries(queryClient)
                                )
                            }
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Refresh
                        </Button>
                    </div>
                }
                description="Active and resolved incident generations produced by complete monitoring snapshots."
                eyebrow="Monitoring"
                title="Incidents"
            />
            <Alert className="mt-5" message={refresh.error} />
            <div className="mt-8">
                <IncidentBrowser />
            </div>
        </div>
    );
}
