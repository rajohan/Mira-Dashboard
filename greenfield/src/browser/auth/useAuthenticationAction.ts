import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import { resetAuthenticatedBrowserCache } from "./authQueries.ts";

/**
 * Runs one login mutation at a time and promotes successful authentication state.
 * @returns The browser client, safe action state, and authentication runner.
 */
export function useAuthenticationAction() {
    const client = useDashboardTrpcClient();
    const collections = useDashboardBrowserCollections();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const action = useExclusiveDashboardAction();

    async function refreshAuthenticationStatus() {
        const status = await client.query("auth.status", {});
        await resetAuthenticatedBrowserCache(queryClient, collections, status);
        return status;
    }

    async function run(operation: () => Promise<unknown>): Promise<void> {
        const result = await action.run(async () => {
            try {
                await operation();
            } catch (error: unknown) {
                try {
                    await refreshAuthenticationStatus();
                } catch {
                    await resetAuthenticatedBrowserCache(queryClient, collections);
                }
                throw error;
            }
            return refreshAuthenticationStatus();
        });
        if (result.status === "success" && result.value.state === "authenticated") {
            await navigate({ replace: true, to: "/" });
        }
    }

    return { ...action, client, run };
}
