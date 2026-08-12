import {
    type QueryClient,
    queryOptions,
    useMutation,
    useQuery,
} from "@tanstack/react-query";
import { useState } from "react";

import { jobRealtimeTopics } from "../../contracts/jobRealtime.ts";
import type { ServiceActionId } from "../../contracts/serviceActions.ts";
import type { DashboardProcedureOutput, DashboardTrpcClient } from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import {
    dashboardBrowserFailureMessage,
    dashboardUnavailableReadRetryDelay,
    isDashboardOperationOutcomeUnknown,
    retryDashboardUnavailableRead,
} from "../api/trpcError.ts";
import { useRealtimeQueryInvalidation } from "../api/useRealtimeQueryInvalidation.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    jobRealtimeFallbackRefreshIntervalMs,
    jobRealtimeRefreshDelayMs,
} from "../jobs/useJobRealtimeInvalidation.ts";
import { Alert } from "../ui/Alert.tsx";
import { Card } from "../ui/Card.tsx";
import { PageState } from "../ui/PageState.tsx";
import { OverviewServiceActionsCard } from "./OverviewServiceActionsCard.tsx";
import {
    authenticatedServiceActionIdentity,
    clearServiceActionRecovery,
    readOrCreateServiceActionIdempotencyKey,
    ServiceActionRecoveryError,
    serviceActionPresentations,
    serviceActionRecoveryExists,
    serviceActionRequestInput,
} from "./serviceActionsOperations.ts";

const serviceActionsStatusQueryKey = ["service-actions", "status"] as const;
const serviceActionMutationKey = ["service-actions", "request"] as const;
const serviceActionUnknownOutcomeMessage =
    "Dashboard could not confirm whether the service action request was queued. Retrying that action reuses the same recovery key; review Dashboard jobs before retrying.";

function serviceActionsStatusQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("serviceActions.getStatus", {}, { signal }),
        queryKey: serviceActionsStatusQueryKey,
        retry: retryDashboardUnavailableRead,
        retryDelay: dashboardUnavailableReadRetryDelay,
        staleTime: 0,
    });
}

async function refreshServiceActionsStatus(queryClient: QueryClient): Promise<void> {
    await queryClient.invalidateQueries({
        exact: true,
        queryKey: serviceActionsStatusQueryKey,
        refetchType: "active",
    });
}

/** Refreshes active fixed-action projections after durable job-run changes. */
function useServiceActionsRealtimeInvalidation(): void {
    useRealtimeQueryInvalidation({
        fallbackRefreshIntervalMs: jobRealtimeFallbackRefreshIntervalMs,
        refreshDelayMs: jobRealtimeRefreshDelayMs,
        refreshQueries: refreshServiceActionsStatus,
        topic: jobRealtimeTopics.runs,
    });
}

/**
 * Owns session-bound fixed-action requests and lost-response recovery identities.
 * @returns One no-retry mutation plus safe feedback and recovery observations.
 */
function useServiceActionRequest() {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    const [error, setError] = useState<string>();
    const [notice, setNotice] = useState<string>();
    const mutation = useMutation<
        DashboardProcedureOutput<"serviceActions.request">,
        Error,
        ServiceActionId
    >({
        mutationFn: (actionId) =>
            boundary.run((signal) => {
                const identity = authenticatedServiceActionIdentity(boundary.queryClient);
                if (identity === undefined) throw new ServiceActionRecoveryError();
                const idempotencyKey = readOrCreateServiceActionIdempotencyKey(
                    identity,
                    actionId
                );
                return client.mutation(
                    "serviceActions.request",
                    serviceActionRequestInput(actionId, idempotencyKey),
                    { signal }
                );
            }),
        mutationKey: serviceActionMutationKey,
        onError: (mutationError) => {
            if (!boundary.completionIsCurrent()) return;
            if (mutationError instanceof ServiceActionRecoveryError) {
                setError(
                    "Dashboard could not persist a safe recovery key in this browser session. The service action was not submitted."
                );
                return;
            }
            setError(
                isDashboardOperationOutcomeUnknown(mutationError)
                    ? serviceActionUnknownOutcomeMessage
                    : dashboardBrowserFailureMessage(mutationError)
            );
        },
        onMutate: () => {
            setError(undefined);
            setNotice(undefined);
        },
        onSuccess: async (result, actionId) => {
            if (!boundary.completionIsCurrent()) return;
            const identity = authenticatedServiceActionIdentity(boundary.queryClient);
            const recoveryCleared =
                identity !== undefined && clearServiceActionRecovery(identity, actionId);
            setNotice(
                `${serviceActionPresentations[actionId].actionLabel} request queued. Dashboard job run: ${result.jobRunId}.`
            );
            if (!recoveryCleared) {
                setError(
                    "The request was confirmed queued, but Dashboard could not clear its browser recovery key. Do not create a new request identity."
                );
            }
            await boundary.queryClient.invalidateQueries({
                exact: true,
                queryKey: serviceActionsStatusQueryKey,
                refetchType: "active",
            });
        },
        retry: false,
    });

    return {
        ...mutation,
        clearError: () => setError(undefined),
        clearNotice: () => setNotice(undefined),
        error,
        notice,
        recoveryPending: (actionId: ServiceActionId) =>
            serviceActionRecoveryExists(
                authenticatedServiceActionIdentity(boundary.queryClient),
                actionId
            ),
    };
}

export interface OverviewServiceActionsSectionProps {
    readonly showJobsLink?: boolean;
}

/** @returns Fixed service-action status, requests, and partial-read handling. */
export function OverviewServiceActionsSection({
    showJobsLink = true,
}: OverviewServiceActionsSectionProps = {}) {
    useServiceActionsRealtimeInvalidation();
    const client = useDashboardTrpcClient();
    const query = useQuery(serviceActionsStatusQueryOptions(client));
    const request = useServiceActionRequest();

    if (query.isPending && query.data === undefined) {
        return (
            <Card aria-label="Service actions">
                <PageState label="Loading service actions…" status="loading" />
            </Card>
        );
    }
    if (query.data === undefined) {
        return (
            <PageState
                headingLevel={2}
                message={dashboardBrowserFailureMessage(query.error)}
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Service actions unavailable"
            />
        );
    }

    return (
        <div>
            {query.error !== null && (
                <Alert
                    className="mb-4"
                    focusOnError={false}
                    message={dashboardBrowserFailureMessage(query.error)}
                />
            )}
            <OverviewServiceActionsCard
                actions={query.data.actions}
                error={request.error}
                notice={request.notice}
                observedAtMs={query.data.observedAtMs}
                onClearError={request.clearError}
                onClearNotice={request.clearNotice}
                onRequest={(actionId, onConfirmed) =>
                    request.mutate(actionId, { onSuccess: onConfirmed })
                }
                recoveryPending={request.recoveryPending}
                requestActionId={request.variables}
                requestBusy={request.isPending}
                showJobsLink={showJobsLink}
            />
        </div>
    );
}
