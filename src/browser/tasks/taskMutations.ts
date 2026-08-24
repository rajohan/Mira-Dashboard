import { useMutation } from "@tanstack/react-query";

import type {
    DashboardMutationName,
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useAuthenticatedMutationBoundary } from "../auth/useAuthenticatedMutationBoundary.ts";
import {
    refreshTaskLists,
    refreshTaskQueries,
    taskDetailQueryKey,
    taskProgressQueryKey,
} from "./taskQueries.ts";

type TaskMutationName = Extract<DashboardMutationName, `tasks.${string}`>;

/**
 * Creates one contract-typed task mutation with shared cache refresh behavior.
 * @param name Exact task mutation procedure.
 * @returns TanStack Query mutation result.
 */
export function useTaskMutation<TName extends TaskMutationName>(name: TName) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<TName>,
        Error,
        DashboardProcedureInput<TName>
    >({
        mutationFn: (input) =>
            boundary.run((signal) => client.mutation(name, input, { signal })),
        onSuccess: async () => {
            if (!boundary.completionIsCurrent()) return;
            await refreshTaskQueries(boundary.queryClient);
        },
    });
}

/**
 * Deletes one task without refetching the detail resource after it disappears.
 * @param onDeleted Closes the mounted task detail before cache cleanup.
 * @returns Contract-typed task deletion mutation.
 */
export function useDeleteTaskMutation(onDeleted: () => void) {
    const client = useDashboardTrpcClient();
    const boundary = useAuthenticatedMutationBoundary();
    return useMutation<
        DashboardProcedureOutput<"tasks.delete">,
        Error,
        DashboardProcedureInput<"tasks.delete">
    >({
        mutationFn: (input) =>
            boundary.run((signal) => client.mutation("tasks.delete", input, { signal })),
        onSuccess: async (result) => {
            if (!boundary.completionIsCurrent()) return;
            onDeleted();
            await refreshTaskLists(boundary.queryClient);
            if (!boundary.completionIsCurrent()) return;
            boundary.queryClient.removeQueries({
                exact: true,
                queryKey: taskDetailQueryKey(result.id),
            });
            boundary.queryClient.removeQueries({
                exact: true,
                queryKey: taskProgressQueryKey(result.id),
            });
        },
    });
}
