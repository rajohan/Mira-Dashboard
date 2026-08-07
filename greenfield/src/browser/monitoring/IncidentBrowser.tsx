import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Filter, RotateCcw, ShieldAlert } from "lucide-react";
import { type FormEvent, type ReactNode, useState } from "react";

import type { ListIncidentsInput } from "../../contracts/incidents.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { incidentSeverityVariant } from "./incidentPresentation.ts";
import { IncidentTable } from "./IncidentTable.tsx";
import {
    incidentDetailQueryOptions,
    incidentListQueryOptions,
    uniqueMonitoringRows,
} from "./monitoringQueries.ts";
import { parseIncidentsRouteSearch } from "./monitoringRouteSearch.ts";

const incidentFilters = Object.freeze([
    { label: "All", value: "all" },
    { label: "Active", value: "active" },
    { label: "Resolved", value: "resolved" },
] as const);

type IncidentFilter = (typeof incidentFilters)[number]["value"];

const severityFilters = Object.freeze([
    { label: "All severities", value: "all" },
    { label: "Critical", value: "critical" },
    { label: "Error", value: "error" },
    { label: "Warning", value: "warning" },
    { label: "Info", value: "info" },
] as const);

type SeverityFilter = (typeof severityFilters)[number]["value"];

function IncidentDetailPanel({ id }: { readonly id: string }) {
    const client = useDashboardTrpcClient();
    const incident = useQuery(incidentDetailQueryOptions(client, id));

    if (incident.isPending && incident.data === undefined) {
        return <PageState label="Loading incident…" status="loading" />;
    }
    if (incident.data === undefined) {
        return (
            <PageState
                message={dashboardBrowserFailureMessage(incident.error)}
                onRetry={() => void incident.refetch()}
                retryBusy={incident.isFetching}
                status="error"
                title="Incident unavailable"
            />
        );
    }
    const detail = incident.data;
    return (
        <Card aria-labelledby="incident-detail-heading" className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
                <Badge variant={incidentSeverityVariant(detail.severity)}>
                    {detail.severity}
                </Badge>
                <Badge variant={detail.state === "active" ? "warning" : "success"}>
                    {detail.state}
                </Badge>
                <Badge>generation {detail.generation}</Badge>
            </div>
            <Heading
                className="mt-3 wrap-break-word"
                id="incident-detail-heading"
                level={2}
            >
                {detail.title}
            </Heading>
            <dl className="mt-5 grid gap-4 sm:grid-cols-2">
                {[
                    ["Monitor", detail.monitorKey],
                    ["Kind", detail.kind],
                    ["Occurrences", String(detail.occurrenceCount)],
                    ["First seen", formatDashboardDateTime(detail.firstSeenAtMs)],
                    ["Last seen", formatDashboardDateTime(detail.lastSeenAtMs)],
                    [
                        "Resolved",
                        detail.state === "resolved"
                            ? formatDashboardDateTime(detail.resolvedAtMs)
                            : "Still active",
                    ],
                ].map(([label, value]) => (
                    <div key={label}>
                        <dt className="text-primary-500 text-xs font-semibold tracking-wide uppercase">
                            {label}
                        </dt>
                        <dd className="text-primary-200 mt-1 text-sm wrap-break-word">
                            {value}
                        </dd>
                    </div>
                ))}
            </dl>
            <details className="border-primary-700 mt-6 rounded-lg border p-3" open>
                <summary className="text-primary-200 cursor-pointer text-sm font-medium">
                    Incident details
                </summary>
                <pre className="bg-primary-950 text-primary-300 mt-3 max-h-96 overflow-auto rounded-lg p-3 text-xs">
                    {JSON.stringify(detail.details, undefined, 2)}
                </pre>
            </details>
        </Card>
    );
}

/** @returns Filtered incident lifecycle navigation and one exact incident record. */
export function IncidentBrowser() {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate({ from: "/incidents" });
    const search = parseIncidentsRouteSearch(
        useSearch({ from: "/incidents" }) as unknown
    );
    const [kindDraft, setKindDraft] = useState("");
    const [monitorDraft, setMonitorDraft] = useState("");
    const [kind, setKind] = useState("");
    const [monitor, setMonitor] = useState("");
    const [stateDraft, setStateDraft] = useState<IncidentFilter>("all");
    const [state, setState] = useState<IncidentFilter>("all");
    const [severityDraft, setSeverityDraft] = useState<SeverityFilter>("all");
    const [severity, setSeverity] = useState<SeverityFilter>("all");
    const filters: ListIncidentsInput["filters"] =
        kind === "" && monitor === "" && state === "all" && severity === "all"
            ? undefined
            : {
                  ...(kind === "" ? {} : { kinds: [kind] }),
                  ...(monitor === "" ? {} : { monitorKeys: [monitor] }),
                  ...(severity === "all" ? {} : { severities: [severity] }),
                  ...(state === "all" ? {} : { states: [state] }),
              };
    const query = useInfiniteQuery(incidentListQueryOptions(client, filters));
    const incidents = uniqueMonitoringRows(
        query.data?.pages.flatMap((page) => page.incidents) ?? []
    );
    const selectedId = search.incidentId;
    const selectIncident = (incidentId: string) => {
        void navigate({ replace: true, search: { incidentId } });
    };
    const applyFilters = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        setKind(kindDraft.trim());
        setMonitor(monitorDraft.trim());
        setState(stateDraft);
        setSeverity(severityDraft);
    };
    const resetFilters = () => {
        setKindDraft("");
        setMonitorDraft("");
        setKind("");
        setMonitor("");
        setStateDraft("all");
        setState("all");
        setSeverityDraft("all");
        setSeverity("all");
    };
    let catalogContent: ReactNode;
    if (query.isPending && query.data === undefined) {
        catalogContent = (
            <div className="p-5">
                <PageState label="Loading incidents…" status="loading" />
            </div>
        );
    } else if (query.data === undefined) {
        catalogContent = (
            <div className="p-5">
                <PageState
                    message={dashboardBrowserFailureMessage(query.error)}
                    onRetry={() => void query.refetch()}
                    retryBusy={query.isFetching}
                    status="error"
                    title="Incidents unavailable"
                />
            </div>
        );
    } else if (incidents.length === 0) {
        catalogContent = (
            <div className="p-5">
                <PageState
                    description="Incident generations will appear when monitoring reports a problem."
                    icon={ShieldAlert}
                    status="empty"
                    title="No incidents"
                />
            </div>
        );
    } else {
        catalogContent = (
            <IncidentTable
                incidents={incidents}
                onSelect={selectIncident}
                selectedId={selectedId}
            />
        );
    }

    return (
        <div>
            <form
                aria-label="Incident filters"
                className="border-primary-700 bg-primary-900/35 grid gap-3 rounded-xl border p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_11rem_11rem_auto] xl:items-end"
                onSubmit={applyFilters}
            >
                <FormField label="Kind">
                    <Input
                        maxLength={100}
                        onChange={(event) => setKindDraft(event.currentTarget.value)}
                        placeholder="e.g. filesystem"
                        value={kindDraft}
                    />
                </FormField>
                <FormField label="Monitor">
                    <Input
                        maxLength={200}
                        onChange={(event) => setMonitorDraft(event.currentTarget.value)}
                        placeholder="e.g. ops-check"
                        value={monitorDraft}
                    />
                </FormField>
                <FormField label="State">
                    <Select
                        onChange={setStateDraft}
                        options={incidentFilters}
                        value={stateDraft}
                    />
                </FormField>
                <FormField label="Severity">
                    <Select
                        onChange={setSeverityDraft}
                        options={severityFilters}
                        value={severityDraft}
                    />
                </FormField>
                <div className="flex gap-2">
                    <Button size="sm" type="submit">
                        <Icon icon={Filter} size="sm" tone="inherit" />
                        Apply
                    </Button>
                    <Button onClick={resetFilters} size="sm" variant="secondary">
                        <Icon icon={RotateCcw} size="sm" tone="inherit" />
                        Reset
                    </Button>
                </div>
            </form>
            {query.error !== null && query.data !== undefined && (
                <Alert
                    className="mt-4"
                    message={dashboardBrowserFailureMessage(query.error)}
                />
            )}
            <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(32rem,42rem)_minmax(0,1fr)]">
                <Card className="min-w-0 p-0">
                    <div className="border-primary-700 border-b px-4 py-3">
                        <Heading level={2} size="subsection">
                            Incidents
                        </Heading>
                    </div>
                    {catalogContent}
                    {query.hasNextPage && (
                        <div className="border-primary-700 border-t p-3">
                            <Button
                                busy={query.isFetchingNextPage}
                                busyLabel="Loading…"
                                fullWidth
                                onClick={() => void query.fetchNextPage()}
                                size="sm"
                                variant="secondary"
                            >
                                Load older incidents
                            </Button>
                        </div>
                    )}
                </Card>
                {selectedId === undefined ? (
                    <PageState
                        description="Choose an incident after monitoring has produced one."
                        icon={ShieldAlert}
                        status="empty"
                        title="No incident selected"
                    />
                ) : (
                    <IncidentDetailPanel id={selectedId} key={selectedId} />
                )}
            </div>
            <Text className="sr-only">
                Incident state is independent of notification read state.
            </Text>
        </div>
    );
}
