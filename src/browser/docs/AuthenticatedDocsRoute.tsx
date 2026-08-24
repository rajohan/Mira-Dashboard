import { useQuery } from "@tanstack/react-query";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { PageState } from "../ui/PageState.tsx";
import { DocsRoute } from "./DocsRoute.tsx";

/**
 * Loads the immutable documentation reference through the authenticated API.
 * @returns Authenticated documentation content or its bounded loading/error state.
 */
export function AuthenticatedDocsRoute() {
    const client = useDashboardTrpcClient();
    const query = useQuery({
        queryFn: ({ signal }) =>
            client.query("system.documentationReference", {}, { signal }),
        queryKey: ["system", "documentation-reference"],
        staleTime: Number.POSITIVE_INFINITY,
    });
    if (query.data === undefined) {
        return query.isPending ? (
            <PageState label="Loading documentation…" status="loading" />
        ) : (
            <PageState
                message="The authenticated documentation reference could not be loaded."
                onRetry={() => void query.refetch()}
                retryBusy={query.isFetching}
                status="error"
                title="Documentation unavailable"
            />
        );
    }
    return <DocsRoute documents={query.data} />;
}
