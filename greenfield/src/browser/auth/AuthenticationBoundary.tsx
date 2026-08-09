import { useQuery } from "@tanstack/react-query";
import { Navigate } from "@tanstack/react-router";
import { type ReactNode, useState } from "react";

import { useDashboardTrpcClient } from "../api/trpcContextValue.ts";
import { dashboardBrowserFailureMessage } from "../api/trpcError.ts";
import { Button } from "../ui/Button.tsx";
import { Card } from "../ui/Card.tsx";
import { Heading } from "../ui/Heading.tsx";
import { Text } from "../ui/Text.tsx";
import { authStatusCacheIdentity, authStatusQueryOptions } from "./authQueries.ts";

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
    const status = useQuery({
        ...authStatusQueryOptions(client),
        refetchOnMount: "always",
    });
    const authenticatedIdentity =
        status.data?.state === "authenticated"
            ? authStatusCacheIdentity(status.data)
            : undefined;
    const verificationSettled =
        status.isFetchedAfterMount && status.fetchStatus === "idle";
    const [releasedIdentity, setReleasedIdentity] = useState<string>();

    if (
        releasedIdentity === undefined &&
        verificationSettled &&
        status.isSuccess &&
        authenticatedIdentity !== undefined
    ) {
        setReleasedIdentity(authenticatedIdentity);
    }

    const verifiedIdentityIsCurrent =
        releasedIdentity !== undefined && releasedIdentity === authenticatedIdentity;

    // Once this exact session has been verified, a background auth.status request
    // must not collapse the route while its previous authenticated result remains
    // current. A resolved identity change still fails closed below and the root
    // cache boundary replaces every session-owned query and collection.
    if (verifiedIdentityIsCurrent && status.isSuccess && !verificationSettled) {
        return children;
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
    if (!verificationSettled) {
        return (
            <output aria-label="Authentication status" className="text-primary-300">
                Checking your session…
            </output>
        );
    }
    if (status.data?.state !== "authenticated") {
        return <Navigate replace to="/login" />;
    }
    if (!verifiedIdentityIsCurrent) {
        return (
            <output aria-label="Authentication status" className="text-primary-300">
                Preparing your session…
            </output>
        );
    }
    return children;
}
