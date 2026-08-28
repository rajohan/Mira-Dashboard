import { QueryClientProvider, type QueryClient } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { lazy, Suspense, useSyncExternalStore, type ReactNode } from "react";
import { ErrorBoundary } from "react-error-boundary";

import type { AuthStatus } from "../contracts/auth.ts";
import { createDashboardQueryClient } from "./api/queryClient.ts";
import {
    createDashboardRealtimeClient,
    type DashboardRealtimeClient,
} from "./api/realtimeClient.ts";
import { DashboardRealtimeProvider } from "./api/realtimeContext.tsx";
import {
    createDashboardTrpcClient,
    createDashboardTrpcTransport,
    type DashboardTrpcClient,
} from "./api/trpcClient.ts";
import { DashboardTrpcProvider } from "./api/trpcContext.tsx";
import { useObservedQueryData } from "./api/useObservedQueryState.ts";
import { AuthenticatedBrowserCacheBoundary } from "./auth/AuthenticatedBrowserCacheBoundary.tsx";
import { AuthenticatedSessionActivity } from "./auth/AuthenticatedSessionActivity.tsx";
import { authStatusCacheIdentity, authStatusQueryKey } from "./auth/authQueries.ts";
import { ChatRuntimeStoreProvider } from "./chat/ChatRuntimeStoreProvider.tsx";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "./data/dashboardCollections.ts";
import { DashboardCollectionsProvider } from "./data/dashboardCollectionsContext.tsx";
import { OperationTrackerProvider } from "./operations/OperationTrackerContext.tsx";
import { createDashboardRouter, type DashboardRouter } from "./router.tsx";
import { AutomationTokenPresentationProvider } from "./security/AutomationTokenPresentationContext.tsx";
import { RecoveryCodesPresentationProvider } from "./security/RecoveryCodesPresentationContext.tsx";
import { SecurityActionNoticeProvider } from "./security/SecurityActionNoticeContext.tsx";
import { SecurityVerificationProvider } from "./security/SecurityVerificationContext.tsx";
import {
    createSecurityVerificationCoordinator,
    type SecurityVerificationCoordinator,
} from "./security/securityVerificationCoordinator.ts";
import {
    createDashboardWebAuthnClient,
    type DashboardWebAuthnClient,
} from "./security/webauthn/webauthnClient.ts";
import { DashboardWebAuthnProvider } from "./security/webauthn/webauthnContext.tsx";
import { AppErrorFallback } from "./ui/AppErrorFallback.tsx";

const queryClient = createDashboardQueryClient();
const realtimeClient = createDashboardRealtimeClient();
const router = createDashboardRouter();
const securityVerification = createSecurityVerificationCoordinator(() => {
    const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
    return status === undefined ? undefined : authStatusCacheIdentity(status);
});
const trpcClient = createDashboardTrpcClient(createDashboardTrpcTransport(), {
    securityVerification,
});
const collections = createDashboardBrowserCollections(queryClient, trpcClient);
const webAuthnClient = createDashboardWebAuthnClient();
const subscribeToNothing = (): (() => void) => () => {};
const noSecurityVerificationSnapshot = (): undefined => void 0;
const LazyGlobalSecurityVerification = lazy(async () => {
    const module = await import("./security/GlobalSecurityVerification.tsx");
    return { default: module.GlobalSecurityVerification };
});

function AuthenticatedOperationTrackerProvider({
    children,
}: {
    readonly children: ReactNode;
}) {
    const authentication = useObservedQueryData<AuthStatus>(authStatusQueryKey);
    return (
        <OperationTrackerProvider
            restoreStoredOperations={authentication?.state === "authenticated"}
        >
            {children}
        </OperationTrackerProvider>
    );
}

/** Browser dependencies accepted by the testable provider boundary. */
export interface DashboardBrowserApplicationProps {
    readonly collections: DashboardBrowserCollections;
    readonly queryClient: QueryClient;
    readonly onAuthenticatedCacheReset?: (queryClient: QueryClient) => void;
    readonly realtimeClient: DashboardRealtimeClient;
    readonly router: DashboardRouter;
    readonly securityVerification?: SecurityVerificationCoordinator;
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
    onAuthenticatedCacheReset,
    realtimeClient,
    router,
    securityVerification,
    trpcClient,
    webAuthnClient,
}: DashboardBrowserApplicationProps) {
    const verificationSnapshot = useSyncExternalStore(
        securityVerification?.subscribe ?? subscribeToNothing,
        securityVerification?.getSnapshot ?? noSecurityVerificationSnapshot,
        securityVerification?.getSnapshot ?? noSecurityVerificationSnapshot
    );
    const verificationActive =
        verificationSnapshot?.phase !== undefined &&
        verificationSnapshot.phase !== "idle";
    function finishAuthenticatedCacheReset(resetQueryClient: QueryClient): void {
        let callbackFailure: Readonly<{ error: unknown }> | undefined;
        try {
            onAuthenticatedCacheReset?.(resetQueryClient);
        } catch (error: unknown) {
            callbackFailure = { error };
        }
        if (securityVerification !== undefined) {
            const status = resetQueryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (status !== undefined) {
                securityVerification.acknowledgeCacheReset(
                    authStatusCacheIdentity(status)
                );
            }
        }
        if (callbackFailure !== undefined) throw callbackFailure.error;
    }

    return (
        <ErrorBoundary FallbackComponent={AppErrorFallback}>
            <QueryClientProvider client={queryClient}>
                <DashboardCollectionsProvider collections={collections}>
                    <DashboardRealtimeProvider client={realtimeClient}>
                        <DashboardTrpcProvider client={trpcClient}>
                            <DashboardWebAuthnProvider client={webAuthnClient}>
                                <SecurityVerificationProvider
                                    coordinator={securityVerification}
                                >
                                    <RecoveryCodesPresentationProvider>
                                        <SecurityActionNoticeProvider>
                                            <AutomationTokenPresentationProvider>
                                                <AuthenticatedBrowserCacheBoundary
                                                    onCacheReset={
                                                        finishAuthenticatedCacheReset
                                                    }
                                                >
                                                    <AuthenticatedSessionActivity
                                                        suspended={verificationActive}
                                                    />
                                                    <AuthenticatedOperationTrackerProvider>
                                                        <ChatRuntimeStoreProvider>
                                                            <RouterProvider
                                                                router={router}
                                                            />
                                                        </ChatRuntimeStoreProvider>
                                                    </AuthenticatedOperationTrackerProvider>
                                                </AuthenticatedBrowserCacheBoundary>
                                                {securityVerification !== undefined && (
                                                    <Suspense fallback={null}>
                                                        <LazyGlobalSecurityVerification
                                                            coordinator={
                                                                securityVerification
                                                            }
                                                            router={router}
                                                        />
                                                    </Suspense>
                                                )}
                                            </AutomationTokenPresentationProvider>
                                        </SecurityActionNoticeProvider>
                                    </RecoveryCodesPresentationProvider>
                                </SecurityVerificationProvider>
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
            securityVerification={securityVerification}
            trpcClient={trpcClient}
            webAuthnClient={webAuthnClient}
        />
    );
}
