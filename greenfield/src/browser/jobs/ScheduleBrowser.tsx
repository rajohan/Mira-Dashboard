import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { CalendarClock } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";

import type { ScheduleConfiguration } from "../../contracts/jobModel.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { ExpandableCard } from "../ui/ExpandableCard.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { LoadingState } from "../ui/LoadingState.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Virtualizer } from "../ui/Virtualizer.tsx";
import { jobBrowserFailureMessage } from "./jobBrowserFailure.ts";
import { useRunScheduleMutation, useUpdateScheduleMutation } from "./jobMutations.ts";
import {
    scheduleDetailQueryOptions,
    scheduleListQueryOptions,
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
    const update = useUpdateScheduleMutation();
    const run = useRunScheduleMutation();
    const historyScrollContainerRef = useRef<HTMLDivElement>(null);
    const historySentinelRef = useRef<HTMLDivElement>(null);
    const fetchNextHistoryPage = history.fetchNextPage;
    const hasNextHistoryPage = history.hasNextPage;
    const historyPageLoading = history.isFetchingNextPage;
    const historyPageFailed = history.error !== null;
    const runs = uniqueJobRows(history.data?.pages.flatMap((page) => page.runs) ?? []);

    useEffect(() => {
        const sentinel = historySentinelRef.current;
        if (
            sentinel === null ||
            !hasNextHistoryPage ||
            historyPageFailed ||
            historyPageLoading ||
            globalThis.IntersectionObserver === undefined
        ) {
            return;
        }
        const observer = new IntersectionObserver(
            (entries) => {
                if (entries.some(({ isIntersecting }) => isIntersecting)) {
                    void fetchNextHistoryPage();
                }
            },
            {
                root: historyScrollContainerRef.current,
                rootMargin: "400px 0px",
            }
        );
        observer.observe(sentinel);
        return () => observer.disconnect();
    }, [fetchNextHistoryPage, hasNextHistoryPage, historyPageFailed, historyPageLoading]);

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
    let historyContent;
    if (history.isPending && history.data === undefined) {
        historyContent = <PageState label="Loading schedule runs…" status="loading" />;
    } else if (history.data === undefined) {
        historyContent = (
            <PageState
                message={jobBrowserFailureMessage(history.error)}
                onRetry={() => void history.refetch()}
                retryBusy={history.isFetching}
                status="error"
                title="Schedule history unavailable"
            />
        );
    } else {
        historyContent = (
            <>
                <Alert
                    className="mb-4"
                    focusOnError={false}
                    message={
                        history.error === null
                            ? undefined
                            : jobBrowserFailureMessage(history.error)
                    }
                />
                {historyPageFailed && (
                    <Button
                        busy={history.isFetching}
                        className="mb-4"
                        onClick={() => void history.refetch()}
                        variant="secondary"
                    >
                        Retry schedule history
                    </Button>
                )}
                <Virtualizer<HTMLLIElement>
                    count={runs.length}
                    estimateSize={() => 180}
                    getItemKey={(index) => runs[index]?.id ?? `missing-run:${index}`}
                    initialRect={{ height: 560, width: 960 }}
                    overscan={4}
                >
                    {({
                        measureElement,
                        scrollContainerRef,
                        totalSize,
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
                        const historyHeight =
                            virtualItems.length > 0 ? totalSize : runs.length * 180;
                        return (
                            <div
                                aria-label="Schedule run history"
                                className="h-[min(42rem,65dvh)] min-h-72 overflow-x-hidden overflow-y-auto overscroll-contain"
                                ref={(node) => {
                                    scrollContainerRef.current = node;
                                    historyScrollContainerRef.current = node;
                                }}
                                // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- The shared Virtualizer requires a div scroll container.
                                role="region"
                                // oxlint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- The bounded virtual run history must remain keyboard-scrollable.
                                tabIndex={0}
                            >
                                <ol
                                    aria-label={`Runs for ${schedule.name}`}
                                    className="relative min-w-0"
                                    style={{ height: historyHeight }}
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
                                                style={{
                                                    transform: `translateY(${virtualItem.start}px)`,
                                                }}
                                            >
                                                <ExpandableCard
                                                    compact
                                                    onOpenChange={(open) =>
                                                        onSelectRun(open ? jobRun.id : "")
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
                                                        onFocusHandled={onRunFocusHandled}
                                                    />
                                                </ExpandableCard>
                                            </li>
                                        );
                                    })}
                                </ol>
                                {hasNextHistoryPage && !historyPageFailed && (
                                    <div className="py-2" ref={historySentinelRef}>
                                        {historyPageLoading && (
                                            <LoadingState
                                                label="Loading older runs…"
                                                size="sm"
                                            />
                                        )}
                                    </div>
                                )}
                            </div>
                        );
                    }}
                </Virtualizer>
                {selectedRunId !== undefined &&
                    !runs.some(({ id: runId }) => runId === selectedRunId) && (
                        <div className="mt-2">
                            <ExpandableCard
                                compact
                                onOpenChange={(open) =>
                                    onSelectRun(open ? selectedRunId : "")
                                }
                                open
                                title="Run details"
                            >
                                <SelectedJobRun
                                    embedded
                                    focusRequested={selectedRunId === runFocusRequested}
                                    id={selectedRunId}
                                    onFocusHandled={onRunFocusHandled}
                                />
                            </ExpandableCard>
                        </div>
                    )}
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
            error={
                mutationError === null && detail.error === null
                    ? undefined
                    : jobBrowserFailureMessage(mutationError ?? detail.error)
            }
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
                    schedules={schedules}
                    selectedId={selectedScheduleId}
                />
                {query.hasNextPage && (
                    <Button
                        busy={query.isFetchingNextPage}
                        busyLabel="Loading…"
                        className="mt-4"
                        onClick={() => void query.fetchNextPage()}
                        variant="secondary"
                    >
                        Load more schedules
                    </Button>
                )}
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
                        className="mx-3 mt-3"
                        focusOnError={false}
                        message={
                            query.data === undefined || query.error === null
                                ? undefined
                                : jobBrowserFailureMessage(query.error)
                        }
                    />
                    <div className="min-h-0 p-2 xl:flex-1 xl:overflow-y-auto">
                        {directoryContent}
                    </div>
                </Card>
                <div className="min-w-0">
                    {selectedScheduleId === undefined ? (
                        <PageState status="empty" title="Select a schedule" />
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
