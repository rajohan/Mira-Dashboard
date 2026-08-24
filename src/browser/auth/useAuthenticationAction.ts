import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import type { AuthStatus } from "../../contracts/auth.ts";
import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { useExclusiveDashboardAction } from "../hooks/useExclusiveDashboardAction.ts";
import type { DashboardActionFailureMessage } from "../hooks/useExclusiveDashboardAction.ts";
import { publishAuthenticationStatus } from "./authQueries.ts";

/**
 * Runs one login mutation at a time and promotes successful authentication state.
 * @returns The browser client, safe action state, and authentication runner.
 */
export function useAuthenticationAction() {
    const client = useDashboardTrpcClient();
    const navigate = useNavigate();
    const queryClient = useQueryClient();
    const action = useExclusiveDashboardAction();

    async function refreshAuthenticationStatus() {
        const status = await client.query("auth.status", {});
        await publishAuthenticationStatus(queryClient, status);
        return status;
    }

    async function run(
        operation: () => Promise<unknown>,
        knownStatus?: AuthStatus,
        failureMessage?: DashboardActionFailureMessage
    ): Promise<boolean> {
        const result = await action.run(async () => {
            try {
                await operation();
            } catch (error: unknown) {
                try {
                    await refreshAuthenticationStatus();
                } catch {
                    try {
                        await publishAuthenticationStatus(queryClient, {
                            state: "anonymous",
                        });
                    } catch {
                        // Preserve the original authentication operation failure.
                    }
                }
                throw error;
            }
            if (knownStatus !== undefined) {
                await publishAuthenticationStatus(queryClient, knownStatus);
                return knownStatus;
            }
            return refreshAuthenticationStatus();
        }, failureMessage);
        if (result.status === "success" && result.value.state === "authenticated") {
            await navigate({ replace: true, to: "/" });
        }
        return result.status === "success";
    }

    return { ...action, client, run };
}
