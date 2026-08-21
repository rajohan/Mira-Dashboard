import { ArrowDown, Download, FileText, RefreshCw, Trash2 } from "lucide-react";
import { type ReactNode, useState } from "react";

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
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { EmptyState } from "../ui/EmptyState.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { PageState } from "../ui/PageState.tsx";
import { SearchInput } from "../ui/SearchInput.tsx";
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
    readonly onClearSearch: () => void;
    readonly onRefresh: () => void;
    readonly onRequestMaintenance: (
        policyId: LogMaintenancePolicyId,
        dryRun: boolean
    ) => Promise<RequestLogMaintenanceOutput>;
    readonly onRetryMaintenance?: () => void;
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
    onActiveLevelsChange,
    rowCount,
    searchQuery,
    snapshot,
}: Readonly<{
    readonly activeLevels: ReadonlySet<FilterableLogLevel>;
    readonly onActiveLevelsChange: (levels: ReadonlySet<FilterableLogLevel>) => void;
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
            : `${visibleLineCount} of ${totalLineCount}`;
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
                        ? "Select one or more log levels."
                        : "Choose another level to include matching classified lines."
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
                            ref={virtualization.containerRef}
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
            <div className="mt-4 grid min-w-0 gap-3 xl:grid-cols-[auto_minmax(0,1fr)_auto] xl:items-center">
                <section
                    aria-label="Log snapshot summary"
                    className="text-primary-400 flex min-w-0 flex-nowrap items-center gap-3 overflow-x-auto text-xs whitespace-nowrap"
                    tabIndex={0}
                >
                    <span>{formatDashboardDateTime(snapshot.observedAtMs)}</span>
                    <span>{formatByteCount(snapshot.scannedBytes)} read</span>
                    <span>{lineCountLabel}</span>
                </section>
                <div className="min-w-0">
                    <LogLevelFilter
                        activeLevels={activeLevels}
                        onChange={onActiveLevelsChange}
                    />
                </div>
                <div className="grid min-w-0 grid-cols-2 gap-2 sm:flex sm:items-center">
                    <Button
                        className="min-w-0 whitespace-nowrap"
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
                        className="min-w-0 whitespace-nowrap"
                        disabled={unclearedLines.length === 0}
                        onClick={() => {
                            setClearedLineIds(
                                new Set(snapshot.lines.map(({ id }) => id))
                            );
                        }}
                        size="sm"
                        variant="secondary"
                    >
                        <Icon icon={Trash2} size="sm" tone="inherit" />
                        Clear buffer
                    </Button>
                </div>
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
    onClearSearch,
    onRefresh,
    onRequestMaintenance,
    onRetryMaintenance,
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
                onActiveLevelsChange={setActiveLevels}
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
            onRequestMaintenance={onRequestMaintenance}
            onRetryMaintenance={onRetryMaintenance}
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
            <Card aria-label="Log viewer">
                <div className="flex items-center gap-3">
                    <Icon icon={FileText} tone="accent" />
                    <Heading id="logs-card-heading" level={2} size="subsection">
                        Logs
                    </Heading>
                </div>
                <div className="border-primary-700 mt-4 grid min-w-0 gap-3 border-t pt-4 lg:grid-cols-[minmax(14rem,22rem)_10rem_minmax(18rem,1fr)] lg:items-end">
                    <FormField label="Log source">
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
                    <FormField label="Lines">
                        <div className="mt-2">
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
                    </FormField>
                    <div className="flex min-w-0 items-end gap-2">
                        <FormField className="min-w-0 flex-1" label="Search logs">
                            <SearchInput
                                className="mt-2"
                                clearLabel="Clear log search"
                                disabled={selectedSource?.availability !== "available"}
                                label="Search logs"
                                maxLength={logSearchMaximumCharacters}
                                onChange={(draft) => {
                                    const query = draft.trim();
                                    setSearchDraft(draft);
                                    if (query.length === 0) onClearSearch();
                                    else onSearch(query);
                                }}
                                placeholder='Try "request-42" or "connection failed"'
                                value={searchDraft}
                            />
                        </FormField>
                    </div>
                </div>
                {selectedSource?.availability !== "available" && (
                    <Alert
                        className="mt-4"
                        focusOnError={false}
                        message="This log source is missing or cannot be read safely."
                    />
                )}
                <Alert className="mt-4" focusOnError={false} message={snapshotError} />
                {snapshotContent}
            </Card>

            {maintenancePanel}
        </div>
    );
}
