import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";
import { authStatusQueryOptions } from "./authQueries.ts";

/** Authenticated route boundary dependencies. */
export interface AuthenticationBoundaryProps {
    readonly children: ReactNode;
}

/**
 * Gates protected browser routes on current server-authenticated session state.
 * The application root separately owns throttled explicit session activity writes.
 * @returns Protected content, a bounded loading/error state, or a login redirect.
 */
export function AuthenticationBoundary({ children }: AuthenticationBoundaryProps) {
    const client = useDashboardTrpcClient();
    const status = useQuery(authStatusQueryOptions(client));

    if (status.isPending) {
        return (
            <output aria-label="Authentication status" className="text-primary-300">
                Checking your session…
            </output>
        );
    }
    if (status.isError) {
        return (
            <Card aria-labelledby="session-check-error" className="max-w-xl" role="alert">
                <Heading id="session-check-error" level={1} size="panel">
                    Session check failed
                </Heading>
                <Text className="mt-3">
                    {dashboardBrowserFailureMessage(status.error)}
                </Text>
                <Button
                    busy={status.isFetching}
                    className="mt-5"
                    onClick={() => void status.refetch()}
                >
                    Try again
                </Button>
            </Card>
        );
    }
    if (status.data.state !== "authenticated") {
        return <Navigate replace to="/login" />;
    }
    return children;
}
