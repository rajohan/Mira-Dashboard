import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";

import type {
    OpenClawCronJob,
    UpdateOpenClawCronPatch,
} from "../../contracts/openClawCron.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import { gatewaySessionQueryOptions } from "../sessions/gatewaySessionQueries.ts";
import type { OpenClawCronDisableDraft } from "./OpenClawCronDisableDialog.tsx";
import {
    accumulateOpenClawCronInventoryPages,
    accumulateOpenClawCronRunPages,
    openClawCronDetailQueryOptions,
    openClawCronListQueryOptions,
    openClawCronQueryKey,
    openClawCronRunsQueryOptions,
    reconcileOpenClawCronQueries,
    refreshOpenClawCronQueries,
} from "./openClawCronQueries.ts";
import { OpenClawCronSection } from "./OpenClawCronSection.tsx";
import { orderOpenClawCronJobs } from "./presentation.ts";

type OpenClawCronMutation =
    | Readonly<{ job: OpenClawCronJob; kind: "delete" }>
    | Readonly<{ job: OpenClawCronJob; kind: "run" }>
    | Readonly<{
          disableIntent?: OpenClawCronDisableDraft;
          enabled: boolean;
          job: OpenClawCronJob;
          kind: "set-enabled";
      }>
    | Readonly<{
          job: OpenClawCronJob;
          kind: "update";
          patch: UpdateOpenClawCronPatch;
      }>;

function requiredRevision(job: OpenClawCronJob): string {
    if (job.configRevision === undefined) {
        throw new Error("OpenClaw cron configuration revision is unavailable");
    }
    return job.configRevision;
}

interface OpenClawCronBrowserProps {
    readonly onSelectedJobChange?: (id: string) => void;
    readonly selectedJobId?: string;
}

function refreshBestEffort(refresh: () => Promise<void>): void {
    void refresh().catch(() => {
        // Keep the confirmed mutation result; polling will retry the validated read.
    });
}

/** @returns Contract-validated Gateway cron queries and recently-authenticated controls. */
export function OpenClawCronBrowser({
    onSelectedJobChange,
    selectedJobId,
}: OpenClawCronBrowserProps = {}) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    const [selectedId, setSelectedId] = useState<string>();
    const unknownOutcomeObservationBoundaryMs = useRef<number | undefined>(undefined);
    const inventory = useInfiniteQuery(openClawCronListQueryOptions(client));
    const inventoryAccumulation = accumulateOpenClawCronInventoryPages(
        inventory.data?.pages ?? []
    );
    const orderedJobs = orderOpenClawCronJobs(inventoryAccumulation?.result.jobs ?? []);
    const effectiveSelectedId =
        ((selectedJobId ?? selectedId) !== undefined &&
        orderedJobs.some((job) => job.id === (selectedJobId ?? selectedId))
            ? (selectedJobId ?? selectedId)
            : undefined) ?? orderedJobs.at(0)?.id;
    const selectedJob = orderedJobs.find((job) => job.id === effectiveSelectedId);
    const heartbeatDetail = useQuery({
        ...openClawCronDetailQueryOptions(client, effectiveSelectedId ?? ""),
        enabled:
            effectiveSelectedId !== undefined &&
            selectedJob?.payload.kind === "heartbeat",
    });
    const heartbeatSessions = useQuery({
        ...gatewaySessionQueryOptions(client),
        enabled: selectedJob?.payload.kind === "heartbeat",
    });
    const heartbeatSession = heartbeatSessions.data?.sessions.find(
        (session) =>
            session.key === `agent:${selectedJob?.agentId ?? "main"}:main:heartbeat`
    );
    const runs = useInfiniteQuery(
        openClawCronRunsQueryOptions(client, effectiveSelectedId)
    );
    const runsAccumulation = accumulateOpenClawCronRunPages(runs.data?.pages ?? []);
    const mutation = useMutation<void, Error, OpenClawCronMutation>({
        mutationFn: (operation) =>
            boundary.run(async (signal) => {
                switch (operation.kind) {
                    case "delete": {
                        await client.mutation(
                            "openClawCron.delete",
                            {
                                expectedConfigRevision: requiredRevision(operation.job),
                                id: operation.job.id,
                            },
                            { signal }
                        );
                        break;
                    }
                    case "run": {
                        await client.mutation(
                            "openClawCron.run",
                            { id: operation.job.id },
                            { signal }
                        );
                        break;
                    }
                    case "set-enabled": {
                        await client.mutation(
                            "openClawCron.setEnabled",
                            {
                                disableIntent: operation.enabled
                                    ? null
                                    : operation.disableIntent,
                                enabled: operation.enabled,
                                expectedConfigRevision: requiredRevision(operation.job),
                                id: operation.job.id,
                            },
                            { signal }
                        );
                        break;
                    }
                    case "update": {
                        await client.mutation(
                            "openClawCron.update",
                            {
                                expectedConfigRevision: requiredRevision(operation.job),
                                ...(operation.patch.scratch === undefined
                                    ? {}
                                    : {
                                          expectedScratchRevision:
                                              operation.job.scratch?.revision,
                                      }),
                                id: operation.job.id,
                                patch: operation.patch,
                            },
                            { signal }
                        );
                        break;
                    }
                }
            }),
        mutationKey: ["openclaw-cron", "mutation"],
        onMutate: () => {
            unknownOutcomeObservationBoundaryMs.current =
                inventoryAccumulation?.result.freshness.observedAtMs;
            return boundary.queryClient.cancelQueries({
                queryKey: openClawCronQueryKey,
            });
        },
        onSuccess: () => {
            if (!boundary.completionIsCurrent()) return;
            refreshBestEffort(() => refreshOpenClawCronQueries(boundary.queryClient));
        },
    });

    const state = (() => {
        if (inventory.isPending && inventoryAccumulation === undefined) {
            return { status: "loading" as const };
        }
        if (inventoryAccumulation === undefined) {
            return {
                message: dashboardBrowserFailureMessage(inventory.error),
                status: "error" as const,
            };
        }
        const detailedHeartbeat = heartbeatDetail.data?.job;
        return {
            result:
                detailedHeartbeat === undefined ||
                detailedHeartbeat.id !== effectiveSelectedId
                    ? inventoryAccumulation.result
                    : {
                          ...inventoryAccumulation.result,
                          jobs: inventoryAccumulation.result.jobs.map((job) =>
                              job.id === detailedHeartbeat.id
                                  ? { ...job, scratch: detailedHeartbeat.scratch }
                                  : job
                          ),
                      },
            status: "ready" as const,
        };
    })();

    const paginationWarning =
        inventoryAccumulation?.stable === false
            ? "The OpenClaw job list changed while more jobs were loading. Refresh before continuing."
            : undefined;
    let runsError: string | undefined;
    if (runsAccumulation?.stable === false) {
        runsError =
            "OpenClaw run history changed while older runs were loading. Refresh before continuing.";
    } else if (runs.error !== null) {
        runsError = dashboardBrowserFailureMessage(runs.error);
    }
    const backgroundError =
        inventory.data !== undefined && inventory.error !== null
            ? dashboardBrowserFailureMessage(inventory.error)
            : paginationWarning;
    if (runsError === backgroundError) runsError = undefined;

    return (
        <OpenClawCronSection
            backgroundError={backgroundError}
            jobsLoadingMore={inventory.isFetchingNextPage}
            heartbeatSession={heartbeatSession}
            onDelete={(job) => mutation.mutateAsync({ job, kind: "delete" })}
            onLoadMoreJobs={
                inventory.hasNextPage && inventoryAccumulation?.stable !== false
                    ? () => void inventory.fetchNextPage()
                    : undefined
            }
            onLoadMoreRuns={
                runs.hasNextPage && runsAccumulation?.stable !== false
                    ? () => void runs.fetchNextPage()
                    : undefined
            }
            onReconcile={async () => {
                if (!boundary.completionIsCurrent()) return false;
                const reconciled = await reconcileOpenClawCronQueries(
                    boundary.queryClient,
                    unknownOutcomeObservationBoundaryMs.current
                );
                return boundary.completionIsCurrent() && reconciled;
            }}
            onRetry={() => void inventory.refetch()}
            onRetryRuns={() => void runs.refetch()}
            onRun={(job) => mutation.mutateAsync({ job, kind: "run" })}
            onSelectJob={(job) => {
                setSelectedId(job.id);
                onSelectedJobChange?.(job.id);
            }}
            onSetEnabled={(job, enabled, disableIntent) =>
                mutation.mutateAsync({ disableIntent, enabled, job, kind: "set-enabled" })
            }
            onUpdate={(job, patch) =>
                mutation.mutateAsync({ job, kind: "update", patch })
            }
            runs={runsAccumulation?.result}
            runsError={runsError}
            runsJobId={effectiveSelectedId}
            runsLoading={runs.isFetching && !runs.isFetchingNextPage}
            runsLoadingMore={runs.isFetchingNextPage}
            selectedJobId={effectiveSelectedId}
            state={state}
        />
    );
}
