import { type QueryClient, useQueries, useQuery } from "@tanstack/react-query";
import { Activity, ExternalLink, X } from "lucide-react";
import { useEffect } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import type { JobRunState } from "../../contracts/jobModel.ts";
import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type { JobRunDetail, ListJobRunsResult } from "../../contracts/jobs.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useObservedQueryData } from "../api/useObservedQueryState.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { authStatusQueryKey } from "../auth/authQueries.ts";
import { jobRunStateBadgeVariant, jobRunStateLabel } from "../jobs/jobRunPresentation.ts";
import { formatDashboardDateTime } from "../lib/formatDateTime.ts";
import { ActionLink } from "../ui/ActionLink.tsx";
import { Badge } from "../ui/Badge.tsx";
import { Card } from "../ui/Card.tsx";
import { Icon } from "../ui/Icon.tsx";
import { IconOnlyButton } from "../ui/IconOnlyButton.tsx";
import { Text } from "../ui/Text.tsx";
import {
    useOperationTracker,
    type OperationTrackerValue,
} from "./operationTrackerContextValue.ts";

const terminalStates = new Set(["cancelled", "failed", "succeeded", "timed-out"]);
const operationRunQueryRoot = ["operations", "runs"] as const;
const activeOperationRunsQueryKey = ["operations", "active-runs"] as const;

async function refreshTrackedOperationRuns(queryClient: QueryClient): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: activeOperationRunsQueryKey }),
        queryClient.invalidateQueries({
            predicate: (query) => {
                const detail = query.state.data as JobRunDetail | undefined;
                return !terminalStates.has(detail?.run.state ?? "");
            },
            queryKey: operationRunQueryRoot,
        }),
    ]);
}

function operationBadgePresentation(lookupFailed: boolean, state?: JobRunState) {
    if (lookupFailed) {
        return Object.freeze({ label: "Status unavailable", variant: "danger" as const });
    }
    if (state === undefined) {
        return Object.freeze({ label: "Loading", variant: "info" as const });
    }
    return Object.freeze({
        label: jobRunStateLabel(state),
        variant: jobRunStateBadgeVariant(state),
    });
}

function latestRunDetail(detail: JobRunDetail | undefined): string | undefined {
    const event = detail?.events?.[0];
    if (event?.message !== undefined) return event.message;
    if (event?.progress !== undefined) {
        const values = Object.entries(event.progress)
            .filter((entry): entry is [string, string | number | boolean] =>
                ["string", "number", "boolean"].includes(typeof entry[1])
            )
            .slice(0, 4)
            .map(([key, value]) => `${key}: ${String(value)}`);
        if (values.length > 0) return values.join(" · ");
    }
    return detail === undefined
        ? undefined
        : `Attempt ${detail.run.attemptCount} of ${detail.run.attemptLimit}`;
}

function PopulatedOperationsTray({ dismiss, operations, settle }: OperationTrackerValue) {
    const client = useDashboardTrpcClient();
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: 30_000,
        refreshDelayMs: 100,
        refreshQueries: refreshTrackedOperationRuns,
        topic: jobRealtimeTopics.runs,
    });
    const details = useQueries({
        queries: operations.map(({ jobRunId }) => ({
            queryFn: ({ signal }: { signal: AbortSignal }): Promise<JobRunDetail> =>
                client.query("jobs.getRun", { eventLimit: 5, id: jobRunId }, { signal }),
            queryKey: [...operationRunQueryRoot, jobRunId] as const,
            refetchInterval: (query: {
                state: {
                    data?: { run?: { state?: string } };
                    status: string;
                };
            }) => {
                if (terminalStates.has(query.state.data?.run?.state ?? "")) {
                    return false;
                }
                return query.state.status === "error" ? 10_000 : 5000;
            },
            staleTime: 0,
        })),
    });
    useEffect(() => {
        for (const [index, operation] of operations.entries()) {
            const query = details[index];
            const state = query?.data?.run.state;
            if (state !== undefined && terminalStates.has(state)) {
                // Query lifecycle is authoritative for pruning completed tray history.
                // oxlint-disable-next-line react-you-might-not-need-an-effect/no-pass-data-to-parent
                settle(operation.jobRunId);
            }
        }
    }, [details, operations, settle]);
    return (
        <aside
            aria-label="Recent operations"
            aria-live="polite"
            className="fixed right-4 bottom-4 z-40 w-[min(24rem,calc(100vw-2rem))] md:top-20 md:bottom-auto"
        >
            <Card className="border-primary-600 bg-primary-950/95 max-h-[min(28rem,70vh)] overflow-y-auto shadow-2xl shadow-black/50 backdrop-blur">
                <div className="mb-3 flex items-center gap-2">
                    <Icon icon={Activity} size="sm" tone="accent" />
                    <Text as="span" className="font-semibold">
                        Recent operations
                    </Text>
                    <Badge className="ml-auto" variant="default">
                        {operations.length}
                    </Badge>
                </div>
                <ul className="space-y-2">
                    {operations.map((operation, index) => {
                        const query = details[index];
                        const detail = query?.data;
                        const state = detail?.run.state;
                        const lookupFailed =
                            query?.isError === true && detail === undefined;
                        const terminal = state !== undefined && terminalStates.has(state);
                        const dismissible = terminal || lookupFailed;
                        const badge = operationBadgePresentation(lookupFailed, state);
                        const latestDetail = latestRunDetail(detail);
                        return (
                            <li
                                className="border-primary-700 rounded-lg border p-3"
                                key={operation.jobRunId}
                            >
                                <div className="flex items-start gap-2">
                                    <div className="min-w-0 flex-1">
                                        <Text as="p" className="font-semibold" size="sm">
                                            {operation.label}
                                        </Text>
                                        {detail !== undefined && (
                                            <Text className="mt-1" size="sm" tone="muted">
                                                Updated{" "}
                                                {formatDashboardDateTime(
                                                    detail.run.updatedAtMs
                                                )}
                                                {` · Attempt ${detail.run.attemptCount}/${detail.run.attemptLimit}`}
                                            </Text>
                                        )}
                                        {latestDetail !== undefined && (
                                            <Text
                                                className="mt-2 wrap-anywhere"
                                                size="sm"
                                            >
                                                {latestDetail}
                                            </Text>
                                        )}
                                        <div className="mt-2 flex flex-wrap items-center gap-2">
                                            <Badge variant={badge.variant}>
                                                {badge.label}
                                            </Badge>
                                            <ActionLink
                                                search={{ runId: operation.jobRunId }}
                                                size="sm"
                                                to="/jobs"
                                                variant="ghost"
                                            >
                                                <Icon icon={ExternalLink} size="sm" />
                                                View job
                                            </ActionLink>
                                        </div>
                                    </div>
                                    {dismissible && (
                                        <IconOnlyButton
                                            icon={X}
                                            label={`Dismiss ${operation.label}`}
                                            onClick={() => dismiss(operation.jobRunId)}
                                            size="sm"
                                            variant="ghost"
                                        />
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ul>
            </Card>
        </aside>
    );
}

/** @returns Floating, route-independent lifecycle view for recently queued jobs. */
export function GlobalOperationsTray() {
    const tracker = useOperationTracker();
    const client = useDashboardTrpcClient();
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    const activeRuns = useQuery({
        enabled: authentication?.state === "authenticated",
        queryFn: ({ signal }): Promise<ListJobRunsResult> =>
            client.query(
                "jobs.listRuns",
                { filters: { states: ["queued", "running"] }, limit: 100 },
                { signal }
            ),
        queryKey: activeOperationRunsQueryKey,
        refetchInterval: 5000,
        staleTime: 0,
    });
    const trackedIds = new Set(tracker.operations.map(({ jobRunId }) => jobRunId));
    const operations = [
        ...tracker.operations,
        ...(activeRuns.data?.runs ?? [])
            .filter(({ id }) => !trackedIds.has(id))
            .map(({ displayName, id }) => ({
                jobRunId: id,
                label: displayName,
                terminal: false,
            })),
    ];
    if (operations.length === 0) return null;
    return <PopulatedOperationsTray {...tracker} operations={operations} />;
}
