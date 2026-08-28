import type { IncidentSummary } from "../../contracts/monitoring.ts";
import { cn } from "../lib/classNames.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import type { InfiniteScrollContinuation } from "../ui/InfiniteScrollTrigger.tsx";
import { incidentSeverityVariant, incidentStateVariant } from "./incidentPresentation.ts";
import { MonitoringSelectionList } from "./MonitoringSelectionList.tsx";

interface IncidentListItemProps {
    readonly incident: IncidentSummary;
    readonly onSelect: (id: string) => void;
    readonly selected: boolean;
}

function IncidentListItem({ incident, onSelect, selected }: IncidentListItemProps) {
    return (
        <Button
            aria-current={selected ? "true" : undefined}
            aria-label={`${incident.title}; ${incident.severity}; ${incident.state}`}
            className={cn(
                "border-primary-700 bg-primary-900/45 hover:border-primary-500 w-full rounded-lg border px-3 py-2 text-left transition",
                selected && "border-accent-500 bg-accent-500/10"
            )}
            onClick={() => onSelect(incident.id)}
            type="button"
            variant="unstyled"
        >
            <span className="flex min-w-0 items-start justify-between gap-2">
                <span className="min-w-0">
                    <span className="text-primary-100 block truncate text-sm font-medium">
                        {incident.title}
                    </span>
                    <Badge
                        className="mt-1 capitalize"
                        variant={incidentStateVariant(incident.state)}
                    >
                        {incident.state}
                    </Badge>
                </span>
                <Badge variant={incidentSeverityVariant(incident.severity)}>
                    {incident.severity}
                </Badge>
            </span>
            <time
                className="text-primary-400 mt-2 block text-xs"
                dateTime={new Date(incident.lastSeenAtMs).toISOString()}
            >
                {formatDashboardDateTime(incident.lastSeenAtMs)}
            </time>
        </Button>
    );
}

interface IncidentTableProps {
    readonly incidents: readonly IncidentSummary[];
    readonly onSelect: (id: string) => void;
    readonly pagination?: InfiniteScrollContinuation;
    readonly selectedId: string | undefined;
}

/** @returns Compact incident selection list with bounded virtual rendering. */
export function IncidentTable({
    incidents,
    onSelect,
    pagination,
    selectedId,
}: IncidentTableProps) {
    return (
        <MonitoringSelectionList
            getKey={(incident) => incident.id}
            items={incidents}
            label="Incidents"
            pagination={pagination}
            renderItem={(incident) => (
                <IncidentListItem
                    incident={incident}
                    onSelect={onSelect}
                    selected={incident.id === selectedId}
                />
            )}
        />
    );
}
