import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";

import type { JobRunEvent } from "../../contracts/jobModel.ts";
import type { JobRunDetail as JobRunDetailData } from "../../contracts/jobs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { PageState } from "../ui/PageState.tsx";
import { jobBrowserFailureMessage } from "./jobBrowserFailure.ts";
import {
    useCancelJobRunMutation,
    useSetJobClaimingPausedMutation,
} from "./jobMutations.ts";
import {
    jobRunDetailQueryOptions,
    type JobRunEventGapRequest,
    type JobRunEventGapResult,
    jobRunEventGapQueryOptions,
    jobRunEventHistoryQueryKey,
    jobRunEventHistoryQueryOptions,
    jobRunListQueryOptions,
    jobQueueSummaryQueryOptions,
    uniqueJobRunEvents,
    uniqueJobRows,
} from "./jobQueries.ts";
import { JobQueuePanel } from "./JobQueuePanel.tsx";
import { parseJobsRouteSearch } from "./jobRouteSearch.ts";
import { JobRunDetail } from "./JobRunDetail.tsx";

interface SelectedJobRunProps {
    readonly embedded?: boolean;
    readonly focusRequested: boolean;
    readonly id: string;
    readonly onFocusHandled: (id: string) => void;
}

function eventGapIdentity(request: JobRunEventGapRequest): string {
    return `${request.cursor.sequence}:${request.knownSequence}`;
}

interface JobRunEventProjection {
    readonly completedGapCount: number;
    readonly eventGapRequests: readonly JobRunEventGapRequest[];
    readonly historyEnabled: boolean;
    readonly observedDetailEvents: readonly JobRunEvent[] | undefined;
    readonly observedGap: JobRunEventGapResult | undefined;
    readonly observedHistoryPages: readonly JobRunDetailData[] | undefined;
    readonly repairedEvents: readonly JobRunEvent[];
    readonly retiredDetailEvents: readonly JobRunEvent[];
}

export function SelectedJobRun({
    embedded = false,
    focusRequested,
    id,
    onFocusHandled,
}: SelectedJobRunProps) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    const detail = useQuery(jobRunDetailQueryOptions(client, id));
    const [historyEnabled, setHistoryEnabled] = useState(
        () => queryClient.getQueryData(jobRunEventHistoryQueryKey(id)) !== undefined
    );
    const firstEventCursor = detail.data?.nextEventCursor;
    const history = useInfiniteQuery(
        jobRunEventHistoryQueryOptions(client, id, firstEventCursor, historyEnabled)
    );
    const [eventProjection, setEventProjection] = useState<JobRunEventProjection>(() => ({
        completedGapCount: 0,
        eventGapRequests: [],
        historyEnabled,
        observedDetailEvents: detail.data?.events,
        observedGap: undefined,
        observedHistoryPages: history.data?.pages,
        repairedEvents: [],
        retiredDetailEvents: [],
    }));
    const eventGapRequest = eventProjection.eventGapRequests.at(
        eventProjection.completedGapCount
    );
    const eventGap = useQuery(jobRunEventGapQueryOptions(client, id, eventGapRequest));
    const cancellation = useCancelJobRunMutation();
    const [confirmingCancel, setConfirmingCancel] = useState(false);
    const currentEvents = detail.data?.events;
    const observedHistoryPages = history.data?.pages;
    if (
        eventProjection.historyEnabled !== historyEnabled ||
        eventProjection.observedDetailEvents !== currentEvents ||
        eventProjection.observedGap !== eventGap.data ||
        eventProjection.observedHistoryPages !== observedHistoryPages
    ) {
        let completedGapCount = eventProjection.completedGapCount;
        let repairedEvents = eventProjection.repairedEvents;
        if (
            eventGapRequest !== undefined &&
            eventGap.data !== undefined &&
            eventGapIdentity(eventGap.data.request) === eventGapIdentity(eventGapRequest)
        ) {
            repairedEvents = uniqueJobRunEvents([
                ...repairedEvents,
                ...eventGap.data.events,
            ]).toSorted((left, right) => right.sequence - left.sequence);
            completedGapCount += 1;
        }

        let retiredDetailEvents = eventProjection.retiredDetailEvents;
        let eventGapRequests = eventProjection.eventGapRequests;
        if (historyEnabled && currentEvents !== undefined) {
            const currentSequences = new Set(
                currentEvents.map(({ sequence }) => sequence)
            );
            retiredDetailEvents = uniqueJobRunEvents([
                ...retiredDetailEvents,
                ...(eventProjection.observedDetailEvents ?? []).filter(
                    ({ sequence }) => !currentSequences.has(sequence)
                ),
            ]).toSorted((left, right) => right.sequence - left.sequence);

            const oldestCurrentSequence = currentEvents.at(-1)?.sequence;
            if (oldestCurrentSequence !== undefined) {
                const knownEvents = [
                    ...(eventProjection.observedDetailEvents ?? []),
                    ...retiredDetailEvents,
                    ...repairedEvents,
                    ...(observedHistoryPages?.flatMap((page) => page.events) ?? []),
                ];
                let knownSequence: number | undefined;
                for (const event of knownEvents) {
                    if (event.sequence >= oldestCurrentSequence) continue;
                    if (knownSequence === undefined || event.sequence > knownSequence) {
                        knownSequence = event.sequence;
                    }
                }
                if (
                    knownSequence !== undefined &&
                    oldestCurrentSequence > knownSequence + 1
                ) {
                    const request = {
                        cursor: { sequence: oldestCurrentSequence },
                        knownSequence,
                    } satisfies JobRunEventGapRequest;
                    const identity = eventGapIdentity(request);
                    if (
                        !eventGapRequests.some(
                            (candidate) => eventGapIdentity(candidate) === identity
                        )
                    ) {
                        eventGapRequests = [...eventGapRequests, request];
                    }
                }
            }
        }
        setEventProjection({
            completedGapCount,
            eventGapRequests,
            historyEnabled,
            observedDetailEvents: currentEvents,
            observedGap: eventGap.data,
            observedHistoryPages,
            repairedEvents,
            retiredDetailEvents,
        });
    }

    if (detail.isPending && detail.data === undefined) {
        return <PageState label="Loading job run…" status="loading" />;
    }
    if (detail.data === undefined) {
        return (
            <PageState
                message={jobBrowserFailureMessage(detail.error)}
                onRetry={() => void detail.refetch()}
                retryBusy={detail.isFetching}
                status="error"
                title="Job run unavailable"
            />
        );
    }

    const mutationError = cancellation.error;
    const error = mutationError ?? detail.error;
    const historyPages = history.data?.pages ?? [];
    const events = uniqueJobRunEvents([
        ...detail.data.events,
        ...eventProjection.retiredDetailEvents,
        ...eventProjection.repairedEvents,
        ...historyPages.flatMap((page) => page.events),
    ]).toSorted((left, right) => right.sequence - left.sequence);
    const nextEventCursor = historyEnabled
        ? (historyPages.at(-1)?.nextEventCursor ??
          (history.data === undefined ? firstEventCursor : undefined))
        : detail.data.nextEventCursor;
    return (
        <div>
            <Alert
                className="mb-4"
                focusOnError={mutationError !== null}
                message={error === null ? undefined : jobBrowserFailureMessage(error)}
            />
            <JobRunDetail
                cancelBusy={cancellation.isPending}
                detail={{ ...detail.data, events, nextEventCursor }}
                embedded={embedded}
                focusRequested={focusRequested}
                onCancel={() => setConfirmingCancel(true)}
                onFocusHandled={onFocusHandled}
            />
            <Alert
                className="mt-4"
                focusOnError={false}
                message={
                    eventGap.error === null && history.error === null
                        ? undefined
                        : jobBrowserFailureMessage(eventGap.error ?? history.error)
                }
            />
            {eventGap.error !== null && (
                <Button
                    busy={eventGap.isFetching}
                    busyLabel="Retrying missing events…"
                    className="mt-4"
                    onClick={() => void eventGap.refetch()}
                    variant="secondary"
                >
                    Retry missing events
                </Button>
            )}
            {nextEventCursor !== undefined && (
                <Button
                    busy={historyEnabled && (eventGap.isFetching || history.isFetching)}
                    busyLabel="Loading older events…"
                    className="mt-4"
                    onClick={() => {
                        if (!historyEnabled) {
                            setHistoryEnabled(true);
                            return;
                        }
                        if (history.data === undefined) {
                            void history.refetch();
                            return;
                        }
                        void history.fetchNextPage();
                    }}
                    variant="secondary"
                >
                    Load older events
                </Button>
            )}
            <ConfirmModal
                busy={cancellation.isPending}
                confirmLabel="Cancel run"
                danger
                description={`Cancel “${detail.data.run.displayName}”? The job will stop if it supports cancellation.`}
                onCancel={() => setConfirmingCancel(false)}
                onConfirm={() =>
                    cancellation.mutate(
                        { id },
                        { onSettled: () => setConfirmingCancel(false) }
                    )
                }
                open={confirmingCancel}
                title="Cancel job run"
            />
        </div>
    );
}

interface JobRunBrowserProps {
    readonly onRequestRunFocus: (id: string) => void;
}

/** @returns Queue state, recent runs, and one exact durable run. */
export function JobRunBrowser({ onRequestRunFocus }: JobRunBrowserProps) {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate({ from: "/jobs" });
    const search = parseJobsRouteSearch(useSearch({ from: "/jobs" }) as unknown);
    const query = useInfiniteQuery(jobRunListQueryOptions(client, undefined));
    const summaryQuery = useQuery(jobQueueSummaryQueryOptions(client));
    const runs = uniqueJobRows(query.data?.pages.flatMap((page) => page.runs) ?? []);
    const summary = summaryQuery.data ?? query.data?.pages[0]?.summary;
    const claiming = useSetJobClaimingPausedMutation();
    const selectRun = (runId: string | undefined) => {
        if (runId !== undefined) onRequestRunFocus(runId);
        const selectedRun = runs.find(({ id }) => id === runId);
        const scheduleId = selectedRun?.scheduledJobId ?? search.scheduleId;
        void navigate({
            replace: true,
            search: {
                ...(search.cronJobId === undefined
                    ? {}
                    : { cronJobId: search.cronJobId }),
                ...(scheduleId === undefined ? {} : { scheduleId }),
                ...(search.source === undefined ? {} : { source: search.source }),
                ...(runId === undefined ? {} : { runId }),
            },
        });
    };
    let backgroundError: unknown;
    if (query.data !== undefined) {
        backgroundError = query.error ?? summaryQuery.error;
    } else if (summaryQuery.data !== undefined) {
        backgroundError = summaryQuery.error;
    }

    return (
        <section aria-label="Dashboard job runs">
            <Alert
                className="mb-4"
                message={
                    claiming.error === null
                        ? undefined
                        : jobBrowserFailureMessage(claiming.error)
                }
            />
            {summary !== undefined && (
                <JobQueuePanel
                    controlBusy={claiming.isPending}
                    onSelectRun={selectRun}
                    onSetClaimingPaused={(paused) =>
                        claiming.mutate({
                            expectedVersion: summary.control.version,
                            paused,
                        })
                    }
                    runs={runs}
                    selectedRunDetail={
                        search.runId === undefined ||
                        search.scheduleId !== undefined ? undefined : (
                            <SelectedJobRun
                                embedded
                                focusRequested={true}
                                id={search.runId}
                                key={search.runId}
                                onFocusHandled={() => {}}
                            />
                        )
                    }
                    selectedRunId={search.runId}
                    summary={summary}
                />
            )}
            {query.data === undefined && (
                <div className="mt-4">
                    {query.isPending ? (
                        <PageState label="Loading job runs…" status="loading" />
                    ) : (
                        <PageState
                            message={jobBrowserFailureMessage(query.error)}
                            onRetry={() => void query.refetch()}
                            retryBusy={query.isFetching}
                            status="error"
                            title="Job history unavailable"
                        />
                    )}
                </div>
            )}
            <Alert
                className="mt-4"
                focusOnError={false}
                message={
                    backgroundError == null
                        ? undefined
                        : jobBrowserFailureMessage(backgroundError)
                }
            />
        </section>
    );
}
