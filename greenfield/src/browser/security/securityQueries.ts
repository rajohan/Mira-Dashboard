import { queryOptions, type QueryClient } from "@tanstack/react-query";

import type { DashboardTrpcClient } from "../api/trpcClient.ts";
import { invalidateAuthenticationStatusWhenAllowed } from "../auth/authQueries.ts";

export const accountSecuritySummaryQueryKey = ["account-security", "summary"] as const;
export const browserSessionsQueryKey = ["auth", "sessions"] as const;
export const securityAuditQueryKey = ["security-audit", "events"] as const;
export const automationPrincipalsQueryKey = [
    "automation-security",
    "principals",
] as const;

/**
 * @param principalId Stable automation principal identity.
 * @returns Stable credential-query key for one automation principal.
 */
export function automationCredentialsQueryKey(principalId: string) {
    return ["automation-security", "credentials", principalId] as const;
}

/** @returns Non-secret account security inventory query options. */
export function accountSecuritySummaryQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("accountSecurity.summary", {}, { signal }),
        queryKey: accountSecuritySummaryQueryKey,
        retry: false,
        staleTime: 0,
    });
}

/** @returns Non-secret browser-session inventory query options. */
export function browserSessionsQueryOptions(client: DashboardTrpcClient) {
    return queryOptions({
        queryFn: ({ signal }) => client.query("auth.sessions", {}, { signal }),
        queryKey: browserSessionsQueryKey,
        retry: false,
        staleTime: 0,
    });
}

/**
 * Refreshes the non-secret security views after a successful mutation.
 * @param queryClient Browser-owned query cache.
 * @returns Completion after active observers have refetched.
 */
export async function refreshSecurityQueries(queryClient: QueryClient): Promise<void> {
    await Promise.all([
        queryClient.invalidateQueries({ queryKey: accountSecuritySummaryQueryKey }),
        invalidateAuthenticationStatusWhenAllowed(queryClient),
        queryClient.invalidateQueries({ queryKey: automationPrincipalsQueryKey }),
        queryClient.invalidateQueries({ queryKey: browserSessionsQueryKey }),
        queryClient.invalidateQueries({ queryKey: securityAuditQueryKey }),
        queryClient.invalidateQueries({
            queryKey: ["automation-security", "credentials"],
        }),
    ]);
}
