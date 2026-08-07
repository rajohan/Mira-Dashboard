import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
    DashboardMutationName,
    DashboardProcedureInput,
    DashboardProcedureOutput,
} from "../api/trpcClient.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
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
    const queryClient = useQueryClient();
    return useMutation<
        DashboardProcedureOutput<TName>,
        Error,
        DashboardProcedureInput<TName>
    >({
        mutationFn: (input) => client.mutation(name, input),
        onSuccess: async () => refreshTaskQueries(queryClient),
    });
}

/**
 * Deletes one task without refetching the detail resource after it disappears.
 * @param onDeleted Closes the mounted task detail before cache cleanup.
 * @returns Contract-typed task deletion mutation.
 */
export function useDeleteTaskMutation(onDeleted: () => void) {
    const client = useDashboardTrpcClient();
    const queryClient = useQueryClient();
    return useMutation<
        DashboardProcedureOutput<"tasks.delete">,
        Error,
        DashboardProcedureInput<"tasks.delete">
    >({
        mutationFn: (input) => client.mutation("tasks.delete", input),
        onSuccess: async (result) => {
            onDeleted();
            await refreshTaskLists(queryClient);
            queryClient.removeQueries({
                exact: true,
                queryKey: taskDetailQueryKey(result.id),
            });
            queryClient.removeQueries({
                exact: true,
                queryKey: taskProgressQueryKey(result.id),
            });
        },
    });
}
