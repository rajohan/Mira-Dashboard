import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";

import { createDashboardQueryClient } from "./api/queryClient.ts";
import {
    createDashboardRealtimeClient,
    type DashboardRealtimeClient,
} from "./api/realtimeClient.ts";
import { DashboardRealtimeProvider } from "./api/realtimeContext.tsx";
import { createDashboardTrpcClient, type DashboardTrpcClient } from "./api/trpcClient.ts";
import { DashboardTrpcProvider } from "./api/trpcContext.tsx";
import { AuthenticatedSessionActivity } from "./auth/AuthenticatedSessionActivity.tsx";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "./data/dashboardCollections.ts";
import { DashboardCollectionsProvider } from "./data/dashboardCollectionsContext.tsx";
import { createDashboardRouter, type DashboardRouter } from "./router.tsx";
import {
    createDashboardWebAuthnClient,
    type DashboardWebAuthnClient,
} from "./security/webauthn/webauthnClient.ts";
import { DashboardWebAuthnProvider } from "./security/webauthn/webauthnContext.tsx";
import { AppErrorFallback } from "./ui/AppErrorFallback.tsx";

const queryClient = createDashboardQueryClient();
const realtimeClient = createDashboardRealtimeClient();
const router = createDashboardRouter();
const trpcClient = createDashboardTrpcClient();
const collections = createDashboardBrowserCollections(queryClient, trpcClient);
const webAuthnClient = createDashboardWebAuthnClient();

/** Browser dependencies accepted by the testable provider boundary. */
export interface DashboardBrowserApplicationProps {
    readonly collections: DashboardBrowserCollections;
    readonly queryClient: QueryClient;
    readonly realtimeClient: DashboardRealtimeClient;
    readonly router: DashboardRouter;
    readonly trpcClient: DashboardTrpcClient;
    readonly webAuthnClient: DashboardWebAuthnClient;
}

/**
 * Renders the root error, query, and routing boundaries.
 * @param props Browser dependencies owned by the composition root.
 * @returns The composed browser provider graph.
 */
export function DashboardBrowserApplication({
    collections,
    queryClient,
    realtimeClient,
    router,
    trpcClient,
    webAuthnClient,
}: DashboardBrowserApplicationProps) {
    return (
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <DashboardTrpcProvider client={trpcClient}>
                            <AuthenticatedSessionActivity />
                            <DashboardWebAuthnProvider client={webAuthnClient}>
                                <RouterProvider router={router} />
                            </DashboardWebAuthnProvider>
                        </DashboardTrpcProvider>
                    </DashboardRealtimeProvider>
                </DashboardCollectionsProvider>
            </QueryClientProvider>
        </ErrorBoundary>
    );
}

/**
 * Owns browser services for the complete document lifetime.
 * @returns The Dashboard application composed with its production dependencies.
 */
export default function DashboardBrowserApplicationRoot() {
    return (
        <DashboardBrowserApplication
            collections={collections}
            queryClient={queryClient}
            realtimeClient={realtimeClient}
            router={router}
            trpcClient={trpcClient}
            webAuthnClient={webAuthnClient}
        />
    );
}
