import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import type { ScheduleConfiguration } from "../../contracts/jobModel.ts";
import {
    liveHistoryRowIdentity,
    useAccumulatedLiveHistoryRows,
} from "../api/liveHistory.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InfiniteScrollTrigger } from "../ui/InfiniteScrollTrigger.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import { jobBrowserFailureMessage } from "./jobBrowserFailure.ts";
import { useRunScheduleMutation, useUpdateScheduleMutation } from "./jobMutations.ts";
import {
    scheduleDetailQueryOptions,
    jobRunDetailQueryOptions,
    scheduleListQueryOptions,
    scheduleRunLiveHeadQueryOptions,
    scheduleRunListQueryOptions,
    uniqueJobRows,
} from "./jobQueries.ts";
import { parseJobsRouteSearch } from "./jobRouteSearch.ts";
import { SelectedJobRun } from "./JobRunBrowser.tsx";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "./jobRunPresentation.ts";
import { ScheduleDetail } from "./ScheduleDetail.tsx";
import { ScheduleTable } from "./ScheduleTable.tsx";

interface SelectedScheduleProps {
    readonly focusRequested: boolean;
    readonly id: string;
    readonly onFocusHandled: (id: string) => void;
    readonly onRunFocusHandled: (id: string) => void;
    readonly onSelectRun: (id: string) => void;
    readonly selectedRunId?: string;
    readonly runFocusRequested?: string;
}

function SelectedScheduleRunCard({
    focusRequested,
    id,
    onFocusHandled,
    onSelectRun,
    preserveSelectionOnClose = false,
}: {
    readonly focusRequested: boolean;
    readonly id: string;
    readonly onFocusHandled: (id: string) => void;
    readonly onSelectRun: (id: string) => void;
    readonly preserveSelectionOnClose?: boolean;
}) {
    const client = useDashboardTrpcClient();
    const detail = useQuery(jobRunDetailQueryOptions(client, id));
    const selectedRun = detail.data?.run;
    const [standaloneOpen, setStandaloneOpen] = useState(true);
    return (
        <div className="mt-2">
            <ExpandableCard
                compact
                onOpenChange={(open) => {
                    if (preserveSelectionOnClose) {
                        setStandaloneOpen(open);
                        return;
                    }
                    onSelectRun(open ? id : "");
                }}
                open={preserveSelectionOnClose ? standaloneOpen : true}
                title={selectedRun?.displayName ?? "Loading run details…"}
                trailing={
                    selectedRun === undefined ? undefined : (
                        <Badge variant={jobRunStateBadgeVariant(selectedRun.state)}>
                            {jobRunStateLabel(selectedRun.state)}
                        </Badge>
                    )
                }
            >
                <SelectedJobRun
                    embedded
                    focusRequested={focusRequested}
                    id={id}
                    onFocusHandled={onFocusHandled}
                />
            </ExpandableCard>
        </div>
    );
}

function SelectedSchedule({
    focusRequested,
    id,
    onFocusHandled,
    onRunFocusHandled,
    onSelectRun,
    runFocusRequested,
    selectedRunId,
}: SelectedScheduleProps) {
    const client = useDashboardTrpcClient();
    const detail = useQuery(scheduleDetailQueryOptions(client, id));
    const history = useInfiniteQuery(scheduleRunListQueryOptions(client, id));
    const liveHead = useQuery(scheduleRunLiveHeadQueryOptions(client, id));
    const update = useUpdateScheduleMutation();
    const run = useRunScheduleMutation();
    const fetchNextHistoryPage = history.fetchNextPage;
    const hasNextHistoryPage = history.hasNextPage;
    const historyPageLoading = history.isFetchingNextPage;
    const historyPageFailed = history.isFetchNextPageError;
    const historyError = liveHead.error ?? history.error;
    const historyHasData = liveHead.data !== undefined || history.data !== undefined;
    const runs = useAccumulatedLiveHistoryRows(
        liveHead.data?.runs ?? [],
        uniqueJobRows(history.data?.pages.flatMap((page) => page.runs) ?? []),
        liveHistoryRowIdentity,
        id
    );

    useEffect(() => {
        if (!focusRequested || detail.data === undefined) return;
        const timer = setTimeout(() => {
            document.querySelector<HTMLElement>("#schedule-detail-heading")?.focus();
            onFocusHandled(id);
        }, 0);
        return () => clearTimeout(timer);
    }, [detail.data, focusRequested, id, onFocusHandled]);

    if (detail.isPending && detail.data === undefined) {
        return <PageState label="Loading schedule…" status="loading" />;
    }
    if (detail.data === undefined) {
        return (
            <PageState
                message={jobBrowserFailureMessage(detail.error)}
                onRetry={() => void detail.refetch()}
                retryBusy={detail.isFetching}
                status="error"
                title="Schedule unavailable"
            />
        );
    }

    const schedule = detail.data;
    const mutationError = update.error ?? run.error;
    const scheduleErrorMessage =
        mutationError === null && detail.error === null
            ? undefined
            : jobBrowserFailureMessage(mutationError ?? detail.error);
    const historyErrorMessage =
        historyError === null ? undefined : jobBrowserFailureMessage(historyError);
    const historyErrorIsDistinct =
        historyErrorMessage !== undefined && historyErrorMessage !== scheduleErrorMessage;
    const historyRetry = historyErrorMessage !== undefined && (
        <Button
            busy={liveHead.isFetching || history.isFetching}
            onClick={() =>
                void Promise.allSettled([liveHead.refetch(), history.refetch()])
            }
            size="sm"
            variant="secondary"
        >
            Retry schedule history
        </Button>
    );
    const selectedRunDetail = selectedRunId !== undefined && (
        <SelectedScheduleRunCard
            focusRequested={selectedRunId === runFocusRequested}
            id={selectedRunId}
            onFocusHandled={onRunFocusHandled}
            onSelectRun={onSelectRun}
        />
    );
    let historyContent;
    if (history.isPending && liveHead.isPending && !historyHasData) {
        historyContent = <PageState label="Loading schedule runs…" status="loading" />;
    } else if (!historyHasData) {
        historyContent = (
            <PageState
                message={jobBrowserFailureMessage(historyError)}
                onRetry={() =>
                    void Promise.allSettled([liveHead.refetch(), history.refetch()])
                }
                retryBusy={liveHead.isFetching || history.isFetching}
                status="error"
                title="Schedule history unavailable"
            />
        );
    } else if (runs.length === 0 && !hasNextHistoryPage && historyError === null) {
        historyContent = (
            <>
                <div className="border-primary-700 bg-primary-900/40 rounded-lg border px-4 py-8 text-center">
                    <Heading level={3} size="subsection">
                        No job runs
                    </Heading>
                    <p className="text-primary-400 mt-1 text-sm">
                        Runs will appear here after this schedule starts a job.
                    </p>
                </div>
                {selectedRunDetail}
            </>
        );
    } else {
        historyContent = (
            <>
                <Alert
                    action={historyErrorIsDistinct ? historyRetry : undefined}
                    className="mb-4"
                    focusOnError={false}
                    message={historyErrorIsDistinct ? historyErrorMessage : undefined}
                />
                <Virtualizer<HTMLLIElement>
                    count={runs.length}
                    estimateSize={() => 180}
                    getItemKey={(index) => runs[index]?.id ?? `missing-run:${index}`}
                    initialRect={{ height: 560, width: 960 }}
                    overscan={4}
                >
                    {({
                        measureElement,
                        containerRef,
                        scrollContainerRef,
                        virtualItems,
                    }) => {
                        const visibleRuns =
                            virtualItems.length > 0
                                ? virtualItems
                                : runs.slice(0, 7).map((jobRun, index) => ({
                                      index,
                                      key: jobRun.id,
                                      start: index * 180,
                                  }));
                        const historyHeight = runs.length * 180;
                        const selectedRunVisible = visibleRuns.some(
                            ({ index }) => runs[index]?.id === selectedRunId
                        );
                        return (
                            <>
                                <section
                                    aria-label="Schedule run history"
                                    className="h-[min(42rem,65dvh)] min-h-72 overflow-x-hidden overflow-y-auto overscroll-contain"
                                    ref={scrollContainerRef}
                                    tabIndex={0}
                                >
                                    <ol
                                        aria-label={`Runs for ${schedule.name}`}
                                        className="relative min-w-0"
                                        ref={containerRef}
                                        style={
                                            virtualItems.length > 0
                                                ? undefined
                                                : { height: historyHeight }
                                        }
                                    >
                                        {visibleRuns.map((virtualItem) => {
                                            const jobRun = runs[virtualItem.index];
                                            if (jobRun === undefined) return null;
                                            return (
                                                <li
                                                    className="absolute top-0 left-0 w-full min-w-0 pb-2"
                                                    data-index={virtualItem.index}
                                                    key={virtualItem.key}
                                                    ref={measureElement}
                                                    style={
                                                        virtualItems.length > 0
                                                            ? undefined
                                                            : {
                                                                  transform: `translateY(${virtualItem.start}px)`,
                                                              }
                                                    }
                                                >
                                                    <ExpandableCard
                                                        compact
                                                        onOpenChange={(open) =>
                                                            onSelectRun(
                                                                open ? jobRun.id : ""
                                                            )
                                                        }
                                                        open={jobRun.id === selectedRunId}
                                                        title={jobRun.displayName}
                                                        trailing={
                                                            <Badge
                                                                variant={jobRunStateBadgeVariant(
                                                                    jobRun.state
                                                                )}
                                                            >
                                                                {jobRunStateLabel(
                                                                    jobRun.state
                                                                )}
                                                            </Badge>
                                                        }
                                                    >
                                                        <SelectedJobRun
                                                            embedded
                                                            focusRequested={
                                                                jobRun.id ===
                                                                runFocusRequested
                                                            }
                                                            id={jobRun.id}
                                                            onFocusHandled={
                                                                onRunFocusHandled
                                                            }
                                                        />
                                                    </ExpandableCard>
                                                </li>
                                            );
                                        })}
                                    </ol>
                                    <InfiniteScrollTrigger
                                        {...(historyPageFailed
                                            ? {
                                                  error: jobBrowserFailureMessage(
                                                      history.error
                                                  ),
                                              }
                                            : {})}
                                        hasMore={hasNextHistoryPage}
                                        loading={historyPageLoading}
                                        loadingLabel="Loading older runs…"
                                        onLoadMore={() => void fetchNextHistoryPage()}
                                        rootRef={scrollContainerRef}
                                    />
                                </section>
                                {selectedRunVisible ? null : selectedRunDetail}
                            </>
                        );
                    }}
                </Virtualizer>
            </>
        );
    }

    const updateSchedule = async (
        patch: Parameters<typeof update.mutateAsync>[0]["patch"],
        expectedVersion = schedule.version
    ): Promise<void> => {
        run.reset();
        await update.mutateAsync({
            expectedVersion,
            id: schedule.id,
            patch,
        });
    };

    return (
        <ScheduleDetail
            disableError={
                update.error === null ? undefined : jobBrowserFailureMessage(update.error)
            }
            error={scheduleErrorMessage}
            errorAction={historyErrorIsDistinct ? undefined : historyRetry}
            errorFocus={mutationError !== null}
            history={historyContent}
            onDisable={(disableIntent, expectedVersion) =>
                updateSchedule({ disableIntent, enabled: false }, expectedVersion)
            }
            onEnable={() => updateSchedule({ disableIntent: null, enabled: true })}
            onOpenDisable={() => {
                update.reset();
                run.reset();
            }}
            onRun={async () => {
                update.reset();
                const enqueued = await run.mutateAsync({ id: schedule.id });
                onSelectRun(enqueued.id);
            }}
            onSaveConfiguration={(configuration: ScheduleConfiguration) =>
                updateSchedule({ schedule: configuration })
            }
            runBusy={run.isPending}
            runReplayAvailable={run.hasPendingRequest(schedule.id)}
            schedule={schedule}
            updateBusy={update.isPending}
        />
    );
}

interface ScheduleBrowserProps {
    readonly focusRunId?: string;
    readonly onRequestRunFocus: (id: string) => void;
    readonly onRunFocusHandled: (id: string) => void;
}

/** @returns Schedule directory, exact editor, and schedule-scoped history. */
export function ScheduleBrowser({
    focusRunId,
    onRequestRunFocus,
    onRunFocusHandled,
}: ScheduleBrowserProps) {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate({ from: "/jobs" });
    const search = parseJobsRouteSearch(useSearch({ from: "/jobs" }) as unknown);
    const [focusScheduleId, setFocusScheduleId] = useState<string>();
    const query = useInfiniteQuery(scheduleListQueryOptions(client, "all"));
    const pageError = query.isFetchNextPageError ? query.error : null;
    const refreshError = query.isFetchNextPageError ? null : query.error;
    const schedules = uniqueJobRows(
        query.data?.pages.flatMap((page) => page.schedules) ?? []
    );
    const selectedScheduleId = search.scheduleId;
    const select = (selection: { runId?: string; scheduleId?: string }) => {
        void navigate({
            replace: true,
            search: {
                ...(search.cronJobId === undefined
                    ? {}
                    : { cronJobId: search.cronJobId }),
                ...selection,
                ...(search.source === undefined ? {} : { source: search.source }),
            },
        });
    };
    const selectSchedule = (scheduleId: string | undefined) => {
        setFocusScheduleId(scheduleId);
        select(scheduleId === undefined ? {} : { scheduleId });
    };
    const selectRun = (runId: string) => {
        if (runId !== "") onRequestRunFocus(runId);
        select({
            ...(runId === "" ? {} : { runId }),
            ...(search.scheduleId === undefined ? {} : { scheduleId: search.scheduleId }),
        });
    };
    let directoryContent: ReactNode;
    if (query.isPending && query.data === undefined) {
        directoryContent = <PageState label="Loading schedules…" status="loading" />;
    } else if (query.data === undefined) {
        directoryContent = (
            <PageState
                message={jobBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Schedule directory unavailable"
            />
        );
    } else if (schedules.length === 0) {
        directoryContent = (
            <PageState
                description="Create or enable a Dashboard schedule to see it here."
                icon={CalendarClock}
                status="empty"
                title="No matching schedules"
            />
        );
    } else {
        directoryContent = (
            <>
                <ScheduleTable
                    onSelect={selectSchedule}
                    pagination={{
                        ...(pageError === null
                            ? {}
                            : { error: jobBrowserFailureMessage(pageError) }),
                        hasMore: query.hasNextPage,
                        loading: query.isFetchingNextPage,
                        loadingLabel: "Loading more schedules…",
                        onLoadMore: () => void query.fetchNextPage(),
                    }}
                    schedules={schedules}
                    selectedId={selectedScheduleId}
                />
            </>
        );
    }

    return (
        <section aria-label="Dashboard schedule management">
            <div className="grid min-w-0 grid-cols-1 gap-3 sm:gap-4 xl:grid-cols-[360px_minmax(0,1fr)]">
                <Card className="min-w-0 p-0 xl:flex xl:max-h-[calc(100vh-10rem)] xl:flex-col xl:overflow-hidden">
                    <div className="border-primary-700 shrink-0 border-b p-3">
                        <div className="flex items-center gap-2">
                            <Icon icon={CalendarClock} tone="accent" />
                            <Heading id="schedules-heading" level={2}>
                                Dashboard schedules
                            </Heading>
                        </div>
                    </div>
                    <Alert
                        action={
                            refreshError === null ? undefined : (
                                <Button
                                    onClick={() => void query.refetch()}
                                    size="sm"
                                    variant="secondary"
                                >
                                    Try again
                                </Button>
                            )
                        }
                        className="mx-3 mt-3"
                        focusOnError={false}
                        message={
                            query.data === undefined || refreshError === null
                                ? undefined
                                : jobBrowserFailureMessage(refreshError)
                        }
                    />
                    <div className="min-h-0 p-2 xl:flex-1 xl:overflow-y-auto">
                        {directoryContent}
                    </div>
                </Card>
                <div className="min-w-0">
                    {selectedScheduleId === undefined ? (
                        search.runId === undefined ? (
                            <PageState status="empty" title="Select a schedule" />
                        ) : (
                            <Card aria-label="Selected job run" className="min-w-0">
                                <Heading level={2}>Job run</Heading>
                                <SelectedScheduleRunCard
                                    focusRequested={focusRunId === search.runId}
                                    id={search.runId}
                                    key={search.runId}
                                    onFocusHandled={onRunFocusHandled}
                                    onSelectRun={selectRun}
                                    preserveSelectionOnClose
                                />
                            </Card>
                        )
                    ) : (
                        <SelectedSchedule
                            focusRequested={focusScheduleId === selectedScheduleId}
                            id={selectedScheduleId}
                            key={selectedScheduleId}
                            onFocusHandled={(id) =>
                                setFocusScheduleId((current) =>
                                    current === id ? undefined : current
                                )
                            }
                            onRunFocusHandled={onRunFocusHandled}
                            onSelectRun={selectRun}
                            runFocusRequested={focusRunId}
                            selectedRunId={search.runId}
                        />
                    )}
                </div>
            </div>
        </section>
    );
}
