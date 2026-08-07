import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ErrorBoundary } from "react-error-boundary";

import { createDashboardQueryClient } from "./api/queryClient.ts";
import { createDashboardTrpcClient, type DashboardTrpcClient } from "./api/trpcClient.ts";
import { DashboardTrpcProvider } from "./api/trpcContext.tsx";
import { createDashboardRouter, type DashboardRouter } from "./router.tsx";
import {
    createDashboardWebAuthnClient,
    type DashboardWebAuthnClient,
} from "./security/webauthn/webauthnClient.ts";
import { DashboardWebAuthnProvider } from "./security/webauthn/webauthnContext.tsx";
import { AppErrorFallback } from "./ui/AppErrorFallback.tsx";

const queryClient = createDashboardQueryClient();
const router = createDashboardRouter();
const trpcClient = createDashboardTrpcClient();
const webAuthnClient = createDashboardWebAuthnClient();

/** Browser dependencies accepted by the testable provider boundary. */
export interface DashboardBrowserApplicationProps {
    readonly queryClient: QueryClient;
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
    queryClient,
    router,
    trpcClient,
    webAuthnClient,
}: DashboardBrowserApplicationProps) {
    return (
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <DashboardWebAuthnProvider client={webAuthnClient}>
                        <RouterProvider router={router} />
                    </DashboardWebAuthnProvider>
                </DashboardTrpcProvider>
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
            queryClient={queryClient}
            router={router}
            trpcClient={trpcClient}
            webAuthnClient={webAuthnClient}
        />
    );
}
