import { ArrowDown, Download, RefreshCw, Search, Trash2, X } from "lucide-react";
import { type ReactNode, useState } from "react";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable log must be keyboard-focusable. */

import type { JobRunDetail } from "../../contracts/jobs.ts";
import {
    logSearchMaximumCharacters,
    type LogLine as LogLineContract,
    type LogMaintenancePolicyId,
    type LogMaintenanceStatusOutput,
    type LogSnapshotOutput,
    type LogSource,
    type RequestLogMaintenanceOutput,
} from "../../contracts/logs.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { formatByteCount } from "../lib/formatMeasurements.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Select } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import { LogLevelFilter } from "./LogLevelFilter.tsx";
import {
    allLogLevels,
    type FilterableLogLevel,
    filterableLogLevels,
    logLevelIsVisible,
} from "./logLevelFiltering.ts";
import { LogLine } from "./LogLine.tsx";
import { presentRedactedLogLine } from "./logLinePresentation.ts";
import { LogMaintenancePanel } from "./LogMaintenancePanel.tsx";
import { logSourceGroupLabel } from "./logPresentation.ts";
import { logSnapshotRowOptions } from "./logQueries.ts";

export interface LogsViewProps {
    readonly maintenance?: LogMaintenanceStatusOutput;
    readonly maintenanceError?: string;
    readonly maintenanceLoading?: boolean;
    readonly maintenanceRefreshing?: boolean;
    readonly onClearSearch: () => void;
    readonly onRefresh: () => void;
    readonly onRefreshMaintenance: () => void;
    readonly onRequestMaintenance: (
        policyId: LogMaintenancePolicyId,
        dryRun: boolean
    ) => Promise<RequestLogMaintenanceOutput>;
    readonly onSearch: (query: string) => void;
    readonly onSelectSource: (sourceId: string) => void;
    readonly onRowCountChange: (rowCount: number) => void;
    readonly refreshing?: boolean;
    readonly requestedRun?: JobRunDetail;
    readonly requestedRunError?: string;
    readonly requestedRunInactiveConfirmed?: boolean;
    readonly requestedRunLoading?: boolean;
    readonly requestedRunRequest?: RequestLogMaintenanceOutput;
    readonly rowCount: number;
    readonly searchQuery?: string;
    readonly selectedSourceId?: string;
    readonly snapshot?: LogSnapshotOutput;
    readonly snapshotError?: string;
    readonly snapshotLoading?: boolean;
    readonly sources: readonly LogSource[];
    readonly sourcesError?: string;
    readonly sourcesLoading?: boolean;
}

function sourceDescription(source: LogSource): string {
    const group = logSourceGroupLabel(source.group);
    if (source.availability !== "available") {
        return `${group} · ${
            source.availability === "missing" ? "Not found" : "Cannot be read"
        }`;
    }
    return source.sizeBytes === undefined
        ? group
        : `${group} · ${formatByteCount(source.sizeBytes)}`;
}

function downloadRedactedLogLines(
    snapshot: LogSnapshotOutput,
    lines: readonly LogLineContract[]
): void {
    const blob = new Blob([lines.map(({ line }) => line).join("\n")], {
        type: "text/plain;charset=utf-8",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.download = `mira-dashboard-${snapshot.sourceId}-${snapshot.revision.slice(0, 12)}.log`;
    anchor.hidden = true;
    anchor.href = url;
    document.body.append(anchor);
    try {
        anchor.click();
    } finally {
        anchor.remove();
        URL.revokeObjectURL(url);
    }
}

function LogSnapshot({
    activeLevels,
    rowCount,
    searchQuery,
    snapshot,
}: Readonly<{
    readonly activeLevels: ReadonlySet<FilterableLogLevel>;
    readonly rowCount: number;
    readonly searchQuery?: string;
    readonly snapshot: LogSnapshotOutput;
}>) {
    const [clearedLineIds, setClearedLineIds] = useState<ReadonlySet<string>>(
        () => new Set()
    );
    const presentedLines = snapshot.lines.map((entry) => ({
        entry,
        presentation: presentRedactedLogLine(entry, {
            referenceTimestampMs: snapshot.observedAtMs,
            sourceId: snapshot.sourceId,
        }),
    }));
    const unclearedLines = presentedLines.filter(
        ({ entry }) => !clearedLineIds.has(entry.id)
    );
    const visibleLines = unclearedLines.filter(({ presentation }) =>
        logLevelIsVisible(presentation.level, activeLevels)
    );
    const activeLevelKey = filterableLogLevels
        .filter((level) => activeLevels.has(level))
        .join(",");
    const scopeKey = `${snapshot.sourceId}:${searchQuery ?? "latest"}:${rowCount}:${activeLevelKey}`;
    const visibleLineCount = visibleLines.length;
    const totalLineCount = snapshot.lines.length;
    const lineCountLabel =
        visibleLineCount === totalLineCount
            ? `${totalLineCount} ${totalLineCount === 1 ? "line" : "lines"}`
            : `${visibleLineCount} of ${totalLineCount} ${
                  totalLineCount === 1 ? "line" : "lines"
              } in this snapshot`;
    let linesContent: ReactNode;
    if (snapshot.lines.length === 0) {
        linesContent = (
            <EmptyState
                className="border-primary-700/70 bg-primary-950/40 mt-4"
                description="Change your search or refresh this source."
                headingLevel={3}
                title="No matching log lines"
            />
        );
    } else if (unclearedLines.length === 0) {
        linesContent = (
            <EmptyState
                className="border-primary-700/70 bg-primary-950/40 mt-4"
                description="Existing rows stay hidden across refreshes. Newly appended rows will appear here."
                headingLevel={3}
                title="Current log buffer cleared"
            />
        );
    } else if (visibleLines.length === 0) {
        linesContent = (
            <EmptyState
                className="border-primary-700/70 bg-primary-950/40 mt-4"
                description={
                    activeLevels.size === 0
                        ? "Select one or more levels, or choose All."
                        : "Choose another level or select All to include every classified line."
                }
                headingLevel={3}
                title="No log lines at the selected levels"
            />
        );
    } else {
        linesContent = (
            <Virtualizer<HTMLLIElement>
                count={visibleLines.length}
                estimateSize={() => 58}
                followToEnd={{ layoutRevision: snapshot.revision, scopeKey }}
                getItemKey={(index) =>
                    visibleLines[index]?.entry.id ?? `missing-log-line:${index}`
                }
                initialRect={{ height: 560, width: 960 }}
                overscan={12}
            >
                {(virtualization) => (
                    <div
                        aria-label="Log lines with sensitive values removed"
                        aria-live="off"
                        className="border-primary-700 bg-primary-950 relative mt-4 h-[min(42rem,65dvh)] min-h-72 overflow-x-hidden overflow-y-auto overscroll-contain rounded-lg border"
                        ref={virtualization.scrollContainerRef}
                        role="log"
                        style={{ overflowAnchor: "none" }}
                        tabIndex={0}
                    >
                        {virtualization.followToEnd?.awayFromEnd === true && (
                            <Button
                                className="border-primary-600 sticky top-2 z-10 float-right mt-2 mr-2 rounded-full border px-3 py-1 text-xs shadow-lg"
                                onClick={virtualization.followToEnd.follow}
                                size="sm"
                                variant="secondary"
                            >
                                <Icon icon={ArrowDown} size="sm" tone="inherit" />
                                Jump to latest
                            </Button>
                        )}
                        <ol
                            className="relative font-mono text-xs"
                            style={{ height: virtualization.totalSize }}
                        >
                            {virtualization.virtualItems.map((virtualRow) => {
                                const row = visibleLines[virtualRow.index];
                                if (row === undefined) return null;
                                return (
                                    <LogLine
                                        dataIndex={virtualRow.index}
                                        entry={row.entry}
                                        key={virtualRow.key}
                                        measureElement={virtualization.measureElement}
                                        presentation={row.presentation}
                                        style={{
                                            left: 0,
                                            position: "absolute",
                                            top: 0,
                                            transform: `translateY(${virtualRow.start}px)`,
                                            width: "100%",
                                        }}
                                    />
                                );
                            })}
                        </ol>
                    </div>
                )}
            </Virtualizer>
        );
    }
    return (
        <>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <div className="text-primary-400 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                    <span>{formatDashboardDateTime(snapshot.observedAtMs)}</span>
                    <span>{formatByteCount(snapshot.scannedBytes)} read</span>
                    <span>{lineCountLabel}</span>
                    {snapshot.hasEarlier && <span>Older lines not shown</span>}
                </div>
                <Button
                    disabled={visibleLines.length === 0}
                    onClick={() =>
                        downloadRedactedLogLines(
                            snapshot,
                            visibleLines.map(({ entry }) => entry)
                        )
                    }
                    size="sm"
                    variant="secondary"
                >
                    <Icon icon={Download} size="sm" tone="inherit" />
                    Export
                </Button>
                <Button
                    disabled={unclearedLines.length === 0}
                    onClick={() => {
                        setClearedLineIds(new Set(snapshot.lines.map(({ id }) => id)));
                    }}
                    size="sm"
                    variant="secondary"
                >
                    <Icon icon={Trash2} size="sm" tone="inherit" />
                    Clear buffer
                </Button>
            </div>
            {linesContent}
        </>
    );
}

/**
 * Pure logs inventory. Server-redacted lines are rendered as inert text and all
 * maintenance choices remain fixed contract identifiers.
 * @returns Accessible log selection, snapshot, and maintenance controls.
 */
export function LogsView({
    maintenance,
    maintenanceError,
    maintenanceLoading = false,
    maintenanceRefreshing = false,
    onClearSearch,
    onRefresh,
    onRefreshMaintenance,
    onRequestMaintenance,
    onRowCountChange,
    onSearch,
    onSelectSource,
    refreshing = false,
    requestedRun,
    requestedRunError,
    requestedRunInactiveConfirmed = false,
    requestedRunLoading = false,
    requestedRunRequest,
    rowCount,
    searchQuery,
    selectedSourceId,
    snapshot,
    snapshotError,
    snapshotLoading = false,
    sources,
    sourcesError,
    sourcesLoading = false,
}: LogsViewProps) {
    const [searchDraft, setSearchDraft] = useState(searchQuery ?? "");
    const [activeLevels, setActiveLevels] =
        useState<ReadonlySet<FilterableLogLevel>>(allLogLevels);
    const selectedSource = sources.find(({ id }) => id === selectedSourceId);

    function submitSearch() {
        const query = searchDraft.trim();
        if (query.length > 0) onSearch(query);
    }

    let snapshotContent: ReactNode;
    if (snapshotLoading && snapshot === undefined) {
        snapshotContent = <LoadingState label="Loading log lines…" />;
    } else if (snapshot === undefined) {
        snapshotContent = (
            <Text className="mt-4" tone="muted">
                Choose an available source to view its latest log lines.
            </Text>
        );
    } else {
        snapshotContent = (
            <LogSnapshot
                activeLevels={activeLevels}
                key={`${snapshot.sourceId}:${searchQuery ?? "latest"}:${rowCount}`}
                rowCount={rowCount}
                searchQuery={searchQuery}
                snapshot={snapshot}
            />
        );
    }

    const maintenancePanel = (
        <LogMaintenancePanel
            maintenance={maintenance}
            maintenanceError={maintenanceError}
            maintenanceLoading={maintenanceLoading}
            maintenanceRefreshing={maintenanceRefreshing}
            onRefresh={onRefreshMaintenance}
            onRequestMaintenance={onRequestMaintenance}
            requestedRun={requestedRun}
            requestedRunError={requestedRunError}
            requestedRunInactiveConfirmed={requestedRunInactiveConfirmed}
            requestedRunLoading={requestedRunLoading}
            requestedRunRequest={requestedRunRequest}
        />
    );
    if (sources.length === 0) {
        let sourceState: ReactNode;
        if (sourcesLoading) {
            sourceState = <LoadingState label="Loading log sources…" />;
        } else if (sourcesError === undefined) {
            sourceState = (
                <EmptyState
                    action={
                        <Button
                            busy={refreshing}
                            busyLabel="Refreshing log sources…"
                            onClick={onRefresh}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Refresh sources
                        </Button>
                    }
                    description="Add a log source to the Dashboard configuration to view it here."
                    title="No log sources"
                />
            );
        } else {
            sourceState = (
                <PageState
                    headingLevel={2}
                    message={sourcesError}
                    onRetry={onRefresh}
                    retryBusy={refreshing}
                    status="error"
                    title="Log sources unavailable"
                />
            );
        }
        return (
            <div className="space-y-6">
                {sourceState}
                {maintenancePanel}
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <Alert focusOnError={false} message={sourcesError} />
            <Card aria-labelledby="log-source-heading">
                <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
                    <div className="min-w-0 flex-1">
                        <Heading id="log-source-heading" level={2} size="subsection">
                            Log source
                        </Heading>
                        <Text className="mt-1" tone="muted">
                            Choose a configured source. File paths stay on the server, and
                            sensitive values are removed before lines reach this page.
                        </Text>
                    </div>
                    <div className="flex w-full gap-2 sm:w-auto">
                        <div className="min-w-0 flex-1 sm:w-32 sm:flex-none">
                            <Select
                                ariaLabel="Log rows"
                                disabled={selectedSource?.availability !== "available"}
                                onChange={(value) => {
                                    const selectedRowCount = logSnapshotRowOptions.find(
                                        (option) => String(option) === value
                                    );
                                    if (selectedRowCount !== undefined) {
                                        onRowCountChange(selectedRowCount);
                                    }
                                }}
                                options={logSnapshotRowOptions.map((option) => ({
                                    label: `${option} lines`,
                                    value: String(option),
                                }))}
                                value={String(rowCount)}
                            />
                        </div>
                        <Button
                            busy={refreshing}
                            busyLabel="Refreshing logs…"
                            onClick={onRefresh}
                            size="sm"
                            variant="secondary"
                        >
                            <Icon icon={RefreshCw} size="sm" tone="inherit" />
                            Refresh
                        </Button>
                    </div>
                </div>
                <div className="mt-5 grid gap-4 lg:grid-cols-[minmax(14rem,22rem)_minmax(18rem,1fr)]">
                    <FormField
                        description={
                            <span
                                aria-hidden="true"
                                className="invisible select-none"
                                data-log-source-description-spacer=""
                            >
                                Searches recent lines from this source.
                            </span>
                        }
                        label="Log source"
                    >
                        <div className="mt-2">
                            <Select
                                ariaLabel="Log source"
                                onChange={(sourceId) => {
                                    setSearchDraft("");
                                    onSelectSource(sourceId);
                                }}
                                options={sources.map((source) => ({
                                    description: sourceDescription(source),
                                    disabled: source.availability !== "available",
                                    label: source.label,
                                    value: source.id,
                                }))}
                                value={selectedSourceId ?? sources[0]!.id}
                            />
                        </div>
                    </FormField>
                    <Form
                        className="flex min-w-0 items-end gap-2"
                        onSubmit={submitSearch}
                    >
                        <FormField
                            className="min-w-0 flex-1"
                            description="Searches recent lines from this source."
                            label="Search logs"
                        >
                            <Input
                                className="mt-2"
                                disabled={selectedSource?.availability !== "available"}
                                maxLength={logSearchMaximumCharacters}
                                onChange={(event) => setSearchDraft(event.target.value)}
                                placeholder='Try "request-42" or "connection failed"'
                                type="search"
                                value={searchDraft}
                            />
                        </FormField>
                        <Button
                            disabled={
                                selectedSource?.availability !== "available" ||
                                searchDraft.trim().length === 0
                            }
                            type="submit"
                            variant="secondary"
                        >
                            <Icon icon={Search} size="sm" tone="inherit" />
                            Search
                        </Button>
                        {searchQuery !== undefined && (
                            <Button
                                aria-label="Clear log search"
                                onClick={() => {
                                    setSearchDraft("");
                                    onClearSearch();
                                }}
                                variant="ghost"
                            >
                                <Icon icon={X} size="sm" tone="inherit" />
                                Latest
                            </Button>
                        )}
                    </Form>
                </div>
            </Card>

            {selectedSource?.availability !== "available" && (
                <Alert
                    focusOnError={false}
                    message="This log source is missing or cannot be read safely."
                />
            )}
            <Alert focusOnError={false} message={snapshotError} />

            <Card aria-labelledby="log-snapshot-heading">
                <div className="flex flex-col justify-between gap-4 xl:flex-row xl:items-start">
                    <div>
                        <div className="flex flex-wrap items-center gap-2">
                            <Heading
                                id="log-snapshot-heading"
                                level={2}
                                size="subsection"
                            >
                                {selectedSource?.label ?? "Log snapshot"}
                            </Heading>
                            <Badge
                                variant={searchQuery === undefined ? "info" : "warning"}
                            >
                                {searchQuery === undefined ? "Latest lines" : "Search"}
                            </Badge>
                        </div>
                        {searchQuery !== undefined && (
                            <Text className="mt-1 break-all" tone="muted">
                                Query: {searchQuery}
                            </Text>
                        )}
                    </div>
                    <div className="min-w-0 xl:max-w-[38rem]">
                        <p className="text-primary-100 mb-2 text-sm font-medium">
                            Log level
                        </p>
                        <LogLevelFilter
                            activeLevels={activeLevels}
                            disabled={snapshot === undefined}
                            onChange={setActiveLevels}
                        />
                    </div>
                </div>
                {snapshotContent}
            </Card>

            {maintenancePanel}
        </div>
    );
}
