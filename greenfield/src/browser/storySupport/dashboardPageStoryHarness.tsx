import type { QueryKey } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { type ReactElement, useEffect, useState } from "react";

import type { DashboardRouteDocumentation } from "../../shared/browserRouteRegistry.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import type {
    DashboardRealtimeClient,
    DashboardRealtimeSubscription,
} from "../api/realtimeClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import { createDashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { TerminalBrowserDependenciesProvider } from "../terminal/terminalBrowserDependencies.tsx";
import type { TerminalBrowserDependencies } from "../terminal/terminalBrowserDependenciesContext.ts";
import {
    DashboardStoryTransport,
    type DashboardStoryFixtures,
} from "./dashboardStoryTransport.ts";

type DashboardStoryRoute = DashboardRouteDocumentation["path"];

const unavailableStoryWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Story WebAuthn unavailable")),
    register: () => Promise.reject(new TypeError("Story WebAuthn unavailable")),
});

const noOpStorySubscription: DashboardRealtimeSubscription = Object.freeze({
    unsubscribe() {},
});

const noOpStoryRealtimeClient: DashboardRealtimeClient = Object.freeze({
    subscribe: () => noOpStorySubscription,
});

export interface DashboardPageStoryProps {
    readonly fixtures?: DashboardStoryFixtures;
    readonly querySeeds?: readonly DashboardPageStoryQuerySeed[];
    readonly route: DashboardStoryRoute;
    readonly terminalBrowserDependencies?: TerminalBrowserDependencies;
}

export interface DashboardPageStoryQuerySeed {
    readonly key: QueryKey;
    readonly updatedAtMs?: number;
    readonly value: unknown;
}

function createPageStoryDependencies({
    fixtures,
    querySeeds = [],
    route,
}: DashboardPageStoryProps) {
    const queryClient = createDashboardQueryClient();
    const trpcClient = createDashboardTrpcClient(new DashboardStoryTransport(fixtures));
    return {
        collections: createDashboardBrowserCollections(queryClient, trpcClient),
        onAuthenticatedCacheReset: () => {
            for (const seed of querySeeds) {
                queryClient.setQueryData(seed.key, seed.value, {
                    updatedAt: seed.updatedAtMs ?? 1,
                });
            }
        },
        queryClient,
        realtimeClient: noOpStoryRealtimeClient,
        router: createDashboardRouter(createMemoryHistory({ initialEntries: [route] })),
        trpcClient,
        webAuthnClient: unavailableStoryWebAuthnClient,
    };
}

/**
 * Renders one real Dashboard route with the production provider graph and a strict,
 * contract-validating fixture transport.
 * @returns The complete production browser provider graph at the selected route.
 */
export function DashboardPageStory({
    fixtures,
    querySeeds,
    route,
    terminalBrowserDependencies,
}: DashboardPageStoryProps): ReactElement {
    const [dependencies] = useState(() =>
        createPageStoryDependencies({ fixtures, querySeeds, route })
    );
    useEffect(
        () => () => {
            dependencies.queryClient.clear();
            void dependencies.collections.cleanup();
        },
        [dependencies]
    );
    return (
        <div className="h-screen min-h-[40rem] w-full min-w-0">
            <TerminalBrowserDependenciesProvider value={terminalBrowserDependencies}>
                <DashboardBrowserApplication {...dependencies} />
            </TerminalBrowserDependenciesProvider>
        </div>
    );
}
