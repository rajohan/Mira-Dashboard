import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Filter, RotateCcw, ShieldAlert } from "lucide-react";
import { type ReactNode, useState } from "react";

import type { ListIncidentsInput } from "../../contracts/incidents.ts";
import { mergeLiveHistoryRows } from "../api/liveHistory.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Form } from "../ui/Form.tsx";
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
    incidentLiveHeadQueryOptions,
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
                <Badge>occurrence group {detail.generation}</Badge>
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
            <ExpandableCard className="mt-6" compact defaultOpen title="Incident details">
                <pre className="bg-primary-950 text-primary-300 max-h-96 overflow-auto rounded-lg p-3 text-xs">
                    {JSON.stringify(detail.details, undefined, 2)}
                </pre>
            </ExpandableCard>
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
    const liveHead = useQuery(incidentLiveHeadQueryOptions(client, filters));
    const incidents = mergeLiveHistoryRows(
        liveHead.data?.incidents ?? [],
        uniqueMonitoringRows(query.data?.pages.flatMap((page) => page.incidents) ?? []),
        ({ id }) => id
    );
    const catalogError = liveHead.error ?? query.error;
    const catalogHasData = liveHead.data !== undefined || query.data !== undefined;
    const retryCatalog = () =>
        void Promise.allSettled([liveHead.refetch(), query.refetch()]);
    const selectedId = search.incidentId;
    const selectIncident = (incidentId: string) => {
        void navigate({ replace: true, search: { incidentId } });
    };
    const applyFilters = () => {
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
    if (liveHead.isPending && query.isPending && !catalogHasData) {
        catalogContent = (
            <div className="p-5">
                <PageState label="Loading incidents…" status="loading" />
            </div>
        );
    } else if (!catalogHasData) {
        catalogContent = (
            <div className="p-5">
                <PageState
                    message={dashboardBrowserFailureMessage(catalogError)}
                    onRetry={retryCatalog}
                    retryBusy={liveHead.isFetching || query.isFetching}
                    status="error"
                    title="Incidents unavailable"
                />
            </div>
        );
    } else if (incidents.length === 0) {
        catalogContent = (
            <div className="p-5">
                <PageState
                    description="Incidents appear when monitoring detects a problem."
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
            <Form
                aria-label="Incident filters"
                className="border-primary-700 bg-primary-900/35 grid gap-3 rounded-xl border p-4 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_11rem_11rem_auto] xl:items-end"
                onSubmit={applyFilters}
            >
                <FormField label="Problem type">
                    <Input
                        className="mt-2"
                        maxLength={100}
                        onChange={(event) => setKindDraft(event.currentTarget.value)}
                        placeholder="filesystem"
                        value={kindDraft}
                    />
                </FormField>
                <FormField label="Check">
                    <Input
                        className="mt-2"
                        maxLength={200}
                        onChange={(event) => setMonitorDraft(event.currentTarget.value)}
                        placeholder="ops-check"
                        value={monitorDraft}
                    />
                </FormField>
                <FormField label="Status">
                    <Select
                        className="mt-2"
                        onChange={setStateDraft}
                        options={incidentFilters}
                        value={stateDraft}
                    />
                </FormField>
                <FormField label="Severity">
                    <Select
                        className="mt-2"
                        onChange={setSeverityDraft}
                        options={severityFilters}
                        value={severityDraft}
                    />
                </FormField>
                <div className="flex min-h-10 items-center gap-2">
                    <Button size="sm" type="submit">
                        <Icon icon={Filter} size="sm" tone="inherit" />
                        Apply
                    </Button>
                    <Button onClick={resetFilters} size="sm" variant="secondary">
                        <Icon icon={RotateCcw} size="sm" tone="inherit" />
                        Reset
                    </Button>
                </div>
            </Form>
            {catalogError !== null && catalogHasData && (
                <Alert
                    action={
                        <Button
                            busy={liveHead.isFetching || query.isFetching}
                            onClick={retryCatalog}
                            size="sm"
                            variant="secondary"
                        >
                            Try again
                        </Button>
                    }
                    className="mt-4"
                    message={dashboardBrowserFailureMessage(catalogError)}
                />
            )}
            <div className="mt-5 grid grid-cols-1 gap-5 xl:grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)]">
                <Card className="min-w-0 p-0">
                    <div className="border-primary-700 border-b px-4 py-3">
                        <div className="flex items-center gap-2">
                            <Icon icon={ShieldAlert} tone="accent" />
                            <Heading level={2} size="subsection">
                                Incidents
                            </Heading>
                        </div>
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
                        description="Choose an incident from the list to see its details."
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
