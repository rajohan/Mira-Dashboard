import { useMutation } from "@tanstack/react-query";
import { useRef } from "react";

import type {
    GatewaySessionAction,
    GatewaySessionActionResult,
    ListGatewaySessionsResult,
} from "../../contracts/gatewaySessions.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { isDashboardOperationOutcomeUnknown } from "../api/trpcError.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    type GatewaySessionMutationName,
    gatewaySessionsClient,
} from "./gatewaySessionClient.ts";
import {
    gatewaySessionQueryKey,
    refreshGatewaySessionQuery,
} from "./gatewaySessionQueries.ts";

export const gatewaySessionMutationKey = ["gateway-sessions", "mutation"] as const;

export type GatewaySessionMutationInput =
    | { readonly action: Exclude<GatewaySessionAction, "delete">; readonly key: string }
    | {
          readonly action: "delete";
          readonly expectedSessionId: string;
          readonly expectedUpdatedAtMs?: number;
          readonly key: string;
      };

function mutationName(action: GatewaySessionAction): GatewaySessionMutationName {
    switch (action) {
        case "compact": {
            return "gatewaySessions.compact";
        }
        case "reset": {
            return "gatewaySessions.reset";
        }
        case "delete": {
            return "gatewaySessions.delete";
        }
    }
}

/** @returns Session-bound compact, reset, and transcript-delete mutation. */
export function useGatewaySessionMutation() {
    const client = gatewaySessionsClient(useDashboardTrpcClient());
    const boundary = useAuthenticatedMutationBoundary();
    const unknownOutcomeObservationBoundaryMs = useRef<number | undefined>(undefined);
    const unknownOutcomeRefresh = useRef<Promise<boolean> | undefined>(undefined);

    async function reconcileUnknownOutcome(): Promise<boolean> {
        let refresh = unknownOutcomeRefresh.current;
        if (refresh !== undefined) {
            const reconciled = await refresh;
            return boundary.completionIsCurrent() && reconciled;
        }
        if (!boundary.completionIsCurrent()) return false;

        refresh = boundary.queryClient
            .refetchQueries(
                {
                    exact: true,
                    queryKey: gatewaySessionQueryKey,
                },
                { throwOnError: true }
            )
            .then(() => {
                if (!boundary.completionIsCurrent()) return false;
                const observationBoundaryMs = unknownOutcomeObservationBoundaryMs.current;
                const snapshot =
                    boundary.queryClient.getQueryData<ListGatewaySessionsResult>(
                        gatewaySessionQueryKey
                    );
                return (
                    observationBoundaryMs !== undefined &&
                    snapshot?.source.freshness === "fresh" &&
                    snapshot.source.observedAtMs > observationBoundaryMs
                );
            })
            .catch(() => false);
        unknownOutcomeRefresh.current = refresh;
        void refresh.finally(() => {
            if (unknownOutcomeRefresh.current === refresh) {
                unknownOutcomeRefresh.current = undefined;
            }
        });
        const reconciled = await refresh;
        return boundary.completionIsCurrent() && reconciled;
    }

    const mutation = useMutation<
        GatewaySessionActionResult,
        Error,
        GatewaySessionMutationInput
    >({
        mutationFn: (input) =>
            boundary.run((signal) => {
                if (input.action === "delete") {
                    return client.mutation(
                        mutationName(input.action),
                        {
                            expectedSessionId: input.expectedSessionId,
                            ...(input.expectedUpdatedAtMs === undefined
                                ? {}
                                : {
                                      expectedUpdatedAtMs: input.expectedUpdatedAtMs,
                                  }),
                            key: input.key,
                        },
                        { signal }
                    );
                }
                return client.mutation(
                    mutationName(input.action),
                    { key: input.key },
                    { signal }
                );
            }),
        mutationKey: gatewaySessionMutationKey,
        onMutate: () => {
            unknownOutcomeObservationBoundaryMs.current =
                boundary.queryClient.getQueryData<ListGatewaySessionsResult>(
                    gatewaySessionQueryKey
                )?.source.observedAtMs;
            return boundary.queryClient.cancelQueries({
                exact: true,
                queryKey: gatewaySessionQueryKey,
            });
        },
        onError: (error) => {
            if (
                !boundary.completionIsCurrent() ||
                !isDashboardOperationOutcomeUnknown(error)
            ) {
                return;
            }
            void reconcileUnknownOutcome();
        },
        onSuccess: async (result) => {
            if (!boundary.completionIsCurrent()) return;
            if (result.refresh.status === "available") {
                const snapshot = result.refresh.snapshot;
                await boundary.queryClient.cancelQueries({
                    exact: true,
                    queryKey: gatewaySessionQueryKey,
                });
                if (!boundary.completionIsCurrent()) return;
                boundary.queryClient.setQueryData(
                    gatewaySessionQueryKey,
                    (current: ListGatewaySessionsResult | undefined) =>
                        current !== undefined &&
                        current.source.observedAtMs > snapshot.source.observedAtMs
                            ? current
                            : snapshot
                );
                return;
            }
            void refreshGatewaySessionQuery(boundary.queryClient).catch(() => {
                // The confirmed action remains authoritative; polling retries the read.
            });
        },
    });

    return { mutation, reconcileUnknownOutcome };
}
