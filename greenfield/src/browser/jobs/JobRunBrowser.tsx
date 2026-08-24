import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { Filter, RotateCcw } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import * as v from "valibot";

import {
    jobResourceClasses,
    type JobResourceClass,
    type JobRunState,
    jobRunStates,
    type JobTriggerType,
    jobTriggerTypes,
    scheduleIdMaximumLength,
    scheduleIdSchema,
} from "../../contracts/jobModel.ts";
import type { ListJobRunsInput } from "../../contracts/jobs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { Alert } from "../ui/Alert.tsx";
import { Button } from "../ui/Button.tsx";
import { ConfirmModal } from "../ui/ConfirmModal.tsx";
import { Form } from "../ui/Form.tsx";
import { FormField } from "../ui/FormField.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Icon } from "../ui/Icon.tsx";
import { Input } from "../ui/Input.tsx";
import { PageState } from "../ui/PageState.tsx";
import { Select, type SelectOption } from "../ui/Select.tsx";
import { Text } from "../ui/Text.tsx";
import { jobBrowserFailureMessage } from "./jobBrowserFailure.ts";
import {
    useCancelJobRunMutation,
    useSetJobClaimingPausedMutation,
} from "./jobMutations.ts";
import {
    jobRunDetailQueryOptions,
    type JobRunEventGapRequest,
    type JobRunEventGapResult,
    jobRunEventGapQueryKey,
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
import { jobRunStateLabel } from "./jobRunPresentation.ts";
import { JobRunTable } from "./JobRunTable.tsx";

type JobStateFilter = JobRunState | "all";
type ResourceClassFilter = JobResourceClass | "all";
type TriggerTypeFilter = JobTriggerType | "all";

const jobStateOptions: readonly SelectOption<JobStateFilter>[] = Object.freeze([
    { label: "All states", value: "all" },
    ...jobRunStates.map((state) => ({ label: jobRunStateLabel(state), value: state })),
]);
const resourceClassOptions: readonly SelectOption<ResourceClassFilter>[] = Object.freeze([
    { label: "All resources", value: "all" },
    ...jobResourceClasses.map((resourceClass) => ({
        label: resourceClass,
        value: resourceClass,
    })),
]);
const triggerTypeOptions: readonly SelectOption<TriggerTypeFilter>[] = Object.freeze([
    { label: "All triggers", value: "all" },
    ...jobTriggerTypes.map((triggerType) => ({
        label: triggerType,
        value: triggerType,
    })),
]);

interface SelectedJobRunProps {
    readonly focusRequested: boolean;
    readonly id: string;
    readonly onFocusHandled: (id: string) => void;
}

function eventGapIdentity(request: JobRunEventGapRequest): string {
    return `${request.cursor.sequence}:${request.knownSequence}`;
}

function SelectedJobRun({ focusRequested, id, onFocusHandled }: SelectedJobRunProps) {
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
    const [eventGapRequests, setEventGapRequests] = useState<
        readonly JobRunEventGapRequest[]
    >([]);
    const cachedEventGap = queryClient.getQueryData<JobRunEventGapResult>(
        jobRunEventGapQueryKey(id)
    );
    const completedEventGapIndex = eventGapRequests.findIndex(
        (request) =>
            cachedEventGap !== undefined &&
            eventGapIdentity(request) === eventGapIdentity(cachedEventGap.request)
    );
    const eventGapRequest = eventGapRequests.at(
        completedEventGapIndex === -1 ? 0 : completedEventGapIndex + 1
    );
    const eventGap = useQuery(jobRunEventGapQueryOptions(client, id, eventGapRequest));
    const refetchEventGap = eventGap.refetch;
    const previousDetailEvents = useRef(detail.data?.events ?? []);
    const [retiredDetailEvents, setRetiredDetailEvents] = useState(
        detail.data?.events.slice(0, 0) ?? []
    );
    const cancellation = useCancelJobRunMutation();
    const [confirmingCancel, setConfirmingCancel] = useState(false);
    const loadedEventGapRequest = eventGap.data?.request;

    useEffect(() => {
        if (eventGapRequest === undefined || eventGap.isFetching) return;
        const identity = eventGapIdentity(eventGapRequest);
        const loadedRequest = loadedEventGapRequest;
        const loadedIdentity =
            loadedRequest === undefined ? undefined : eventGapIdentity(loadedRequest);
        if (loadedIdentity === identity) return;
        if (eventGap.error !== null) return;
        void refetchEventGap();
    }, [
        eventGap.error,
        eventGap.isFetching,
        eventGapRequest,
        loadedEventGapRequest,
        refetchEventGap,
    ]);

    useEffect(() => {
        const currentEvents = detail.data?.events;
        if (currentEvents === undefined) return;
        if (historyEnabled) {
            const currentSequences = new Set(
                currentEvents.map(({ sequence }) => sequence)
            );
            const newlyRetired = previousDetailEvents.current.filter(
                ({ sequence }) => !currentSequences.has(sequence)
            );
            if (newlyRetired.length > 0) {
                setRetiredDetailEvents((events) =>
                    uniqueJobRunEvents([...events, ...newlyRetired]).toSorted(
                        (left, right) => right.sequence - left.sequence
                    )
                );
            }
            const oldestCurrentSequence = currentEvents.at(-1)?.sequence;
            if (oldestCurrentSequence !== undefined) {
                const knownEvents = [
                    ...previousDetailEvents.current,
                    ...retiredDetailEvents,
                    ...(eventGap.data?.events ?? []),
                    ...(history.data?.pages.flatMap((page) => page.events) ?? []),
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
                    setEventGapRequests((current) => {
                        const identity = eventGapIdentity(request);
                        if (
                            current.some(
                                (candidate) => eventGapIdentity(candidate) === identity
                            )
                        ) {
                            return current;
                        }
                        return [...current, request];
                    });
                }
            }
        }
        previousDetailEvents.current = currentEvents;
    }, [
        detail.data?.events,
        eventGap.data,
        history.data?.pages,
        historyEnabled,
        retiredDetailEvents,
    ]);

    useEffect(() => {
        if (!focusRequested || detail.data === undefined) return;
        const heading = document.querySelector<HTMLElement>(`#job-run-${id}-heading`);
        if (heading === null) return;
        heading.focus();
        onFocusHandled(id);
    }, [detail.data, focusRequested, id, onFocusHandled]);

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
        ...retiredDetailEvents,
        ...(eventGap.data?.events ?? []),
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
                onCancel={() => setConfirmingCancel(true)}
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
    readonly focusRunId?: string;
    readonly onRequestRunFocus: (id: string) => void;
    readonly onRunFocusHandled: (id: string) => void;
}

/** @returns Queue state, filterable global history, and one exact durable run. */
export function JobRunBrowser({
    focusRunId,
    onRequestRunFocus,
    onRunFocusHandled,
}: JobRunBrowserProps) {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate({ from: "/jobs" });
    const search = parseJobsRouteSearch(useSearch({ from: "/jobs" }) as unknown);
    const [stateDraft, setStateDraft] = useState<JobStateFilter>("all");
    const [stateFilter, setStateFilter] = useState<JobStateFilter>("all");
    const [resourceClassDraft, setResourceClassDraft] =
        useState<ResourceClassFilter>("all");
    const [resourceClassFilter, setResourceClassFilter] =
        useState<ResourceClassFilter>("all");
    const [triggerTypeDraft, setTriggerTypeDraft] = useState<TriggerTypeFilter>("all");
    const [triggerTypeFilter, setTriggerTypeFilter] = useState<TriggerTypeFilter>("all");
    const [scheduleDraft, setScheduleDraft] = useState("");
    const [scheduleFilter, setScheduleFilter] = useState<string>();
    const [scheduleFilterError, setScheduleFilterError] = useState<string>();
    const scheduleFilterInputRef = useRef<HTMLInputElement>(null);
    const filters: ListJobRunsInput["filters"] = (() => {
        if (
            stateFilter === "all" &&
            resourceClassFilter === "all" &&
            triggerTypeFilter === "all" &&
            scheduleFilter === undefined
        ) {
            return;
        }
        return {
            ...(resourceClassFilter === "all"
                ? {}
                : { resourceClasses: [resourceClassFilter] }),
            ...(scheduleFilter === undefined ? {} : { scheduleId: scheduleFilter }),
            ...(stateFilter === "all" ? {} : { states: [stateFilter] }),
            ...(triggerTypeFilter === "all" ? {} : { triggerTypes: [triggerTypeFilter] }),
        };
    })();
    const query = useInfiniteQuery(jobRunListQueryOptions(client, filters));
    const summaryQuery = useQuery(jobQueueSummaryQueryOptions(client));
    const runs = uniqueJobRows(query.data?.pages.flatMap((page) => page.runs) ?? []);
    const summary = summaryQuery.data ?? query.data?.pages[0]?.summary;
    const claiming = useSetJobClaimingPausedMutation();
    const selectRun = (runId: string | undefined) => {
        if (runId !== undefined) onRequestRunFocus(runId);
        void navigate({
            replace: true,
            search: {
                ...(search.cronJobId === undefined
                    ? {}
                    : { cronJobId: search.cronJobId }),
                ...(search.scheduleId === undefined
                    ? {}
                    : { scheduleId: search.scheduleId }),
                ...(search.source === undefined ? {} : { source: search.source }),
                ...(runId === undefined ? {} : { runId }),
            },
        });
    };
    const applyFilters = () => {
        const candidate = scheduleDraft.trim();
        let nextScheduleFilter: string | undefined;
        if (candidate.length > 0) {
            const parsed = v.safeParse(scheduleIdSchema, candidate);
            if (!parsed.success) {
                setScheduleFilterError(
                    "Enter a schedule ID such as system.worker-smoke."
                );
                setTimeout(() => scheduleFilterInputRef.current?.focus(), 0);
                return;
            }
            nextScheduleFilter = parsed.output;
        }
        setStateFilter(stateDraft);
        setResourceClassFilter(resourceClassDraft);
        setTriggerTypeFilter(triggerTypeDraft);
        setScheduleFilter(nextScheduleFilter);
        setScheduleFilterError(undefined);
    };
    const resetFilters = () => {
        setStateDraft("all");
        setStateFilter("all");
        setResourceClassDraft("all");
        setResourceClassFilter("all");
        setTriggerTypeDraft("all");
        setTriggerTypeFilter("all");
        setScheduleDraft("");
        setScheduleFilter(undefined);
        setScheduleFilterError(undefined);
    };
    let runListContent: ReactNode;
    if (query.isPending && query.data === undefined) {
        runListContent = <PageState label="Loading job runs…" status="loading" />;
    } else if (query.data === undefined) {
        runListContent = (
            <PageState
                message={jobBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Job history unavailable"
            />
        );
    } else {
        runListContent = (
            <>
                <JobRunTable onSelect={selectRun} runs={runs} selectedId={search.runId} />
                {query.hasNextPage && (
                    <Button
                        busy={query.isFetchingNextPage}
                        busyLabel="Loading…"
                        className="mt-4"
                        onClick={() => void query.fetchNextPage()}
                        variant="secondary"
                    >
                        Load more runs
                    </Button>
                )}
            </>
        );
    }
    let backgroundError: unknown;
    if (query.data !== undefined) {
        backgroundError = query.error ?? summaryQuery.error;
    } else if (summaryQuery.data !== undefined) {
        backgroundError = summaryQuery.error;
    }

    return (
        <section aria-labelledby="job-runs-heading">
            <div className="mb-4">
                <Heading id="job-runs-heading" level={2}>
                    Queue and run history
                </Heading>
                <Text className="mt-1" tone="muted">
                    See what is waiting or running, available workers, saved output, and
                    cancellation status.
                </Text>
            </div>
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
                    onSetClaimingPaused={(paused) =>
                        claiming.mutate({
                            expectedVersion: summary.control.version,
                            paused,
                        })
                    }
                    summary={summary}
                />
            )}
            <Form
                aria-label="Job run filters"
                className="border-primary-700 bg-primary-900/35 mt-6 grid gap-3 rounded-xl border p-4 md:grid-cols-2 xl:grid-cols-[repeat(3,minmax(0,1fr))_minmax(12rem,1fr)_auto] xl:items-end"
                onSubmit={applyFilters}
            >
                <FormField label="Status">
                    <Select
                        className="mt-2 capitalize"
                        onChange={setStateDraft}
                        options={jobStateOptions}
                        value={stateDraft}
                    />
                </FormField>
                <FormField label="Work size">
                    <Select
                        className="mt-2 capitalize"
                        onChange={setResourceClassDraft}
                        options={resourceClassOptions}
                        value={resourceClassDraft}
                    />
                </FormField>
                <FormField label="Started by">
                    <Select
                        className="mt-2 capitalize"
                        onChange={setTriggerTypeDraft}
                        options={triggerTypeOptions}
                        value={triggerTypeDraft}
                    />
                </FormField>
                <FormField error={scheduleFilterError} label="Schedule ID">
                    <Input
                        className="mt-2 font-mono"
                        maxLength={scheduleIdMaximumLength}
                        onChange={(event) => {
                            setScheduleFilterError(undefined);
                            setScheduleDraft(event.currentTarget.value);
                        }}
                        placeholder="system.worker-smoke"
                        ref={scheduleFilterInputRef}
                        value={scheduleDraft}
                    />
                </FormField>
                <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-1">
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
            <Alert
                className="mt-4"
                focusOnError={false}
                message={
                    backgroundError == null
                        ? undefined
                        : jobBrowserFailureMessage(backgroundError)
                }
            />
            <div className="mt-5">{runListContent}</div>
            <div className="mt-7">
                {search.runId === undefined ? (
                    <PageState
                        description="Choose a run from the table to see its details."
                        status="empty"
                        title="Select a job run"
                    />
                ) : (
                    <SelectedJobRun
                        focusRequested={focusRunId === search.runId}
                        id={search.runId}
                        key={search.runId}
                        onFocusHandled={onRunFocusHandled}
                    />
                )}
            </div>
        </section>
    );
}
