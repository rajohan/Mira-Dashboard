import { ArrowDown, RefreshCw, RotateCcw, Search, ShieldCheck, X } from "lucide-react";
import { type ReactNode, useState } from "react";
/* eslint-disable jsx-a11y/no-noninteractive-tabindex -- The scrollable log must be keyboard-focusable. */

import {
    logSearchMaximumCharacters,
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
import { Modal } from "../ui/Modal.tsx";
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
import { logFailureMessage, logSourceGroupLabel } from "./logPresentation.ts";

export interface LogsViewProps {
    readonly maintenance?: LogMaintenanceStatusOutput;
    readonly maintenanceError?: string;
    readonly maintenanceLoading?: boolean;
    readonly onClearSearch: () => void;
    readonly onRefresh: () => void;
    readonly onRequestMaintenance: (
        policyId: LogMaintenancePolicyId
    ) => Promise<RequestLogMaintenanceOutput>;
    readonly onSearch: (query: string) => void;
    readonly onSelectSource: (sourceId: string) => void;
    readonly refreshing?: boolean;
    readonly searchQuery?: string;
    readonly selectedSourceId?: string;
    readonly snapshot?: LogSnapshotOutput;
    readonly snapshotError?: string;
    readonly snapshotLoading?: boolean;
    readonly sources: readonly LogSource[];
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

function LogSnapshot({
    activeLevels,
    searchQuery,
    snapshot,
}: Readonly<{
    readonly activeLevels: ReadonlySet<FilterableLogLevel>;
    readonly searchQuery?: string;
    readonly snapshot: LogSnapshotOutput;
}>) {
    const presentedLines = snapshot.lines.map((entry) => ({
        entry,
        presentation: presentRedactedLogLine(entry, {
            referenceTimestampMs: snapshot.observedAtMs,
            sourceId: snapshot.sourceId,
        }),
    }));
    const visibleLines = presentedLines.filter(({ presentation }) =>
        logLevelIsVisible(presentation.level, activeLevels)
    );
    const activeLevelKey = filterableLogLevels
        .filter((level) => activeLevels.has(level))
        .join(",");
    const scopeKey = `${snapshot.sourceId}:${searchQuery ?? "latest"}:${activeLevelKey}`;
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
            <div className="text-primary-400 mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>{formatDashboardDateTime(snapshot.observedAtMs)}</span>
                <span>{formatByteCount(snapshot.scannedBytes)} read</span>
                <span>{lineCountLabel}</span>
                {snapshot.hasEarlier && <span>Older lines not shown</span>}
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
    onSearch,
    onSelectSource,
    refreshing = false,
    searchQuery,
    selectedSourceId,
    snapshot,
    snapshotError,
    snapshotLoading = false,
    sources,
}: LogsViewProps) {
    const [actionError, setActionError] = useState<string>();
    const [actionStatus, setActionStatus] = useState<string>();
    const [confirmPolicyId, setConfirmPolicyId] = useState<LogMaintenancePolicyId>();
    const [runningPolicyId, setRunningPolicyId] = useState<LogMaintenancePolicyId>();
    const [searchDraft, setSearchDraft] = useState(searchQuery ?? "");
    const [activeLevels, setActiveLevels] =
        useState<ReadonlySet<FilterableLogLevel>>(allLogLevels);
    const selectedSource = sources.find(({ id }) => id === selectedSourceId);
    const confirmedPolicy = maintenance?.policies.find(
        ({ id }) => id === confirmPolicyId
    );

    function submitSearch() {
        const query = searchDraft.trim();
        if (query.length > 0) onSearch(query);
    }

    async function runMaintenance(policyId: LogMaintenancePolicyId) {
        setActionError(undefined);
        setActionStatus(undefined);
        setRunningPolicyId(policyId);
        try {
            const result = await onRequestMaintenance(policyId);
            setConfirmPolicyId(undefined);
            setActionStatus(
                `${confirmedPolicy?.label ?? "Log maintenance"} was added to the queue as job ${result.jobRunId}.`
            );
        } catch (error) {
            setActionError(logFailureMessage(error));
        } finally {
            setRunningPolicyId(undefined);
        }
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
                searchQuery={searchQuery}
                snapshot={snapshot}
            />
        );
    }

    if (sources.length === 0) {
        return (
            <EmptyState
                description="Add a log source to the Dashboard configuration to view it here."
                title="No log sources"
            />
        );
    }

    return (
        <div className="space-y-6">
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

            <Card aria-labelledby="log-maintenance-heading">
                <div className="flex items-start gap-3">
                    <Icon className="mt-0.5 shrink-0" icon={ShieldCheck} tone="accent" />
                    <div>
                        <Heading id="log-maintenance-heading" level={2} size="subsection">
                            Log maintenance
                        </Heading>
                        <Text className="mt-1" tone="muted">
                            Dashboard rotates application and container logs. System log
                            cleanup uses the four configured Ubuntu cleanup jobs.
                        </Text>
                    </div>
                </div>
                <Alert className="mt-4" focusOnError={false} message={maintenanceError} />
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={actionError}
                    onDismiss={() => setActionError(undefined)}
                />
                <Alert
                    className="mt-4"
                    focusOnError={false}
                    message={actionStatus}
                    onDismiss={() => setActionStatus(undefined)}
                    variant="success"
                />
                {maintenanceLoading && maintenance === undefined ? (
                    <LoadingState label="Checking log maintenance options…" />
                ) : (
                    <ul className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                        {(maintenance?.policies ?? []).map((policy) => (
                            <li
                                className="border-primary-700 bg-primary-950/45 rounded-lg border p-4"
                                key={policy.id}
                            >
                                <div className="flex items-start justify-between gap-3">
                                    <div className="min-w-0">
                                        <p className="text-primary-100 font-medium">
                                            {policy.label}
                                        </p>
                                        <div className="mt-2 flex gap-2">
                                            <Badge>
                                                {policy.scope === "docker"
                                                    ? "Apps and containers"
                                                    : "System"}
                                            </Badge>
                                            <Badge
                                                variant={
                                                    policy.state === "queueable"
                                                        ? "success"
                                                        : "danger"
                                                }
                                            >
                                                {policy.state === "queueable"
                                                    ? "Ready"
                                                    : "Unavailable"}
                                            </Badge>
                                        </div>
                                    </div>
                                    <Button
                                        aria-label={`Run ${policy.label}`}
                                        disabled={policy.state !== "queueable"}
                                        onClick={() => setConfirmPolicyId(policy.id)}
                                        size="sm"
                                        variant="secondary"
                                    >
                                        <Icon icon={RotateCcw} size="sm" tone="inherit" />
                                        Run
                                    </Button>
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </Card>

            <Modal
                description="This adds the configured cleanup job to the queue. You must have verified your identity recently with multi-factor authentication."
                dismissible={runningPolicyId === undefined}
                onClose={() => setConfirmPolicyId(undefined)}
                open={confirmedPolicy !== undefined}
                size="sm"
                title={`Run ${confirmedPolicy?.label ?? "log maintenance"}?`}
            >
                <div className="flex justify-end gap-2">
                    <Button
                        disabled={runningPolicyId !== undefined}
                        onClick={() => setConfirmPolicyId(undefined)}
                        variant="secondary"
                    >
                        Cancel
                    </Button>
                    <Button
                        busy={runningPolicyId !== undefined}
                        busyLabel="Adding log maintenance to the queue…"
                        onClick={() => {
                            if (confirmedPolicy !== undefined) {
                                void runMaintenance(confirmedPolicy.id);
                            }
                        }}
                    >
                        Add to queue
                    </Button>
                </div>
            </Modal>
        </div>
    );
}
