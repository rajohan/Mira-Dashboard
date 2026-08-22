import { describe, expect, test } from "bun:test";

import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { act, useEffect } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import { createDashboardTrpcClient } from "../api/trpcClient.ts";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { DashboardCollectionsProvider } from "../data/dashboardCollectionsContext.tsx";
import { useDashboardBrowserCollections } from "../data/dashboardCollectionsContextValue.ts";
import { AuthenticatedBrowserCacheBoundary } from "./AuthenticatedBrowserCacheBoundary.tsx";
import {
    authStatusQueryKey,
    publishAuthenticationStatus,
    resetAuthenticatedBrowserCache,
} from "./authQueries.ts";

const { render, screen, waitFor } = await import("@testing-library/react");

const privateQueryKey = ["private", "session-owned"] as const;
type AuthenticatedAuthStatus = Extract<AuthStatus, { state: "authenticated" }>;

function authenticatedStatus(
    lastSeenAtMs: number,
    sessionId: string
): AuthenticatedAuthStatus {
    return {
        session: {
            authenticatedAtMs: lastSeenAtMs,
            authMethod: "password",
            createdAtMs: lastSeenAtMs,
            expiresAtMs: lastSeenAtMs + 86_400_000,
            id: sessionId,
            isCurrent: true,
            lastSeenAtMs,
            userAgent: "Dashboard cache boundary test",
        },
        state: "authenticated",
        user: {
            id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
            email: "operator@example.com",
            username: "operator",
        },
    };
}

function createUnexpectedTrpcClient() {
    return createDashboardTrpcClient({
        mutation(path) {
            return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
        },
        query(path) {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        },
    });
}

interface DeferredReset {
    readonly completion: Promise<void>;
    readonly gate: PromiseWithResolvers<void>;
}

function deferCollectionResets(source: DashboardBrowserCollections) {
    const resets: DeferredReset[] = [];
    const collections: DashboardBrowserCollections = Object.freeze({
        get agents() {
            return source.agents;
        },
        get notifications() {
            return source.notifications;
        },
        cleanup: () => source.cleanup(),
        reset() {
            const gate = Promise.withResolvers<void>();
            const completion = gate.promise.then(() => source.reset());
            resets.push({ completion, gate });
            return completion;
        },
    });

    return {
        collections,
        async release(index: number): Promise<void> {
            const reset = resets[index];
            if (reset === undefined) {
                throw new TypeError(`Reset ${index} has not started`);
            }
            reset.gate.resolve();
            await reset.completion;
        },
        async releaseAll(): Promise<void> {
            for (const reset of resets) reset.gate.resolve();
            await Promise.allSettled(resets.map((reset) => reset.completion));
        },
        get resetCount() {
            return resets.length;
        },
    };
}

interface CacheRelease {
    readonly agents: DashboardBrowserCollections["agents"];
    readonly authentication: AuthStatus | undefined;
    readonly privateValue: unknown;
}

function BrowserCacheProbe({
    onRelease,
}: {
    readonly onRelease: (release: CacheRelease) => void;
}) {
    const queryClient = useQueryClient();
    const collections = useDashboardBrowserCollections();

    useEffect(() => {
        onRelease({
            agents: collections.agents,
            authentication: queryClient.getQueryData<AuthStatus>(authStatusQueryKey),
            privateValue: queryClient.getQueryData(privateQueryKey),
        });
    }, [collections, onRelease, queryClient]);

    return <output>Authenticated browser child</output>;
}

function renderBoundary(initialStatus: AuthStatus) {
    const queryClient = createDashboardQueryClient();
    const client = createUnexpectedTrpcClient();
    const sourceCollections = createDashboardBrowserCollections(queryClient, client);
    const deferredCollections = deferCollectionResets(sourceCollections);
    const releases: CacheRelease[] = [];
    queryClient.setQueryData(authStatusQueryKey, initialStatus);
    const view = render(
        <QueryClientProvider client={queryClient}>
            <DashboardCollectionsProvider collections={deferredCollections.collections}>
                <AuthenticatedBrowserCacheBoundary>
                    <BrowserCacheProbe onRelease={(release) => releases.push(release)} />
                </AuthenticatedBrowserCacheBoundary>
            </DashboardCollectionsProvider>
        </QueryClientProvider>
    );

    return {
        deferredCollections,
        queryClient,
        releases,
        sourceCollections,
        view,
    };
}

async function cleanupBoundary(
    fixture: ReturnType<typeof renderBoundary>
): Promise<void> {
    fixture.view.unmount();
    await fixture.deferredCollections.releaseAll();
    await fixture.sourceCollections.cleanup();
    fixture.queryClient.clear();
}

describe("authenticated browser cache boundary", () => {
    test("releases a new collection and empty private cache after an A-to-B transition", async () => {
        const timestampMs = Date.now();
        const statusA = authenticatedStatus(timestampMs, "a".repeat(32));
        const statusB = authenticatedStatus(timestampMs + 1, "b".repeat(32));
        const fixture = renderBoundary(statusA);

        try {
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(1));
            expect(screen.queryByText("Authenticated browser child")).toBeNull();

            await act(() => fixture.deferredCollections.release(0));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            await waitFor(() => expect(fixture.releases).toHaveLength(1));
            const releasedACollections = fixture.releases[0]?.agents;
            fixture.queryClient.setQueryData(privateQueryKey, {
                owner: "session-a",
            });

            act(() => {
                fixture.queryClient.setQueryData(authStatusQueryKey, statusB);
            });
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(2));
            expect(screen.queryByText("Authenticated browser child")).toBeNull();
            expect(fixture.releases).toHaveLength(1);

            await act(() => fixture.deferredCollections.release(1));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            await waitFor(() => expect(fixture.releases).toHaveLength(2));
            expect(fixture.releases[1]).toMatchObject({
                authentication: statusB,
                privateValue: undefined,
            });
            expect(fixture.releases[1]?.agents).not.toBe(releasedACollections);
        } finally {
            await cleanupBoundary(fixture);
        }
    });

    test("stays fail-closed through a deferred A-to-B-to-A reset race", async () => {
        const timestampMs = Date.now();
        const statusA = authenticatedStatus(timestampMs, "a".repeat(32));
        const statusB = authenticatedStatus(timestampMs + 1, "b".repeat(32));
        const fixture = renderBoundary(statusA);

        try {
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(1));
            await act(() => fixture.deferredCollections.release(0));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            await waitFor(() => expect(fixture.releases).toHaveLength(1));
            const releasedACollections = fixture.releases[0]?.agents;

            act(() => {
                fixture.queryClient.setQueryData(authStatusQueryKey, statusB);
            });
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(2));
            expect(screen.queryByText("Authenticated browser child")).toBeNull();

            act(() => {
                fixture.queryClient.setQueryData(authStatusQueryKey, {
                    ...statusA,
                    session: {
                        ...statusA.session,
                        lastSeenAtMs: timestampMs + 2,
                    },
                });
            });
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(3));

            await act(() => fixture.deferredCollections.release(1));
            expect(screen.queryByText("Authenticated browser child")).toBeNull();
            expect(fixture.releases).toHaveLength(1);
            expect(fixture.queryClient.getQueryData(authStatusQueryKey)).toMatchObject({
                session: { id: statusA.session.id },
            });

            await act(() => fixture.deferredCollections.release(2));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            await waitFor(() => expect(fixture.releases).toHaveLength(2));
            expect(fixture.releases[1]?.agents).not.toBe(releasedACollections);
            expect(fixture.releases[1]?.authentication).toMatchObject({
                session: { id: statusA.session.id, lastSeenAtMs: timestampMs + 2 },
            });
        } finally {
            await cleanupBoundary(fixture);
        }
    });

    test("releases an unresolved auth observer after status disappears mid-reset", async () => {
        const timestampMs = Date.now();
        const statusA = authenticatedStatus(timestampMs, "a".repeat(32));
        const statusB = authenticatedStatus(timestampMs + 1, "b".repeat(32));
        const fixture = renderBoundary(statusA);

        try {
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(1));
            await act(() => fixture.deferredCollections.release(0));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            fixture.queryClient.setQueryData(privateQueryKey, {
                owner: "session-a",
            });

            act(() => {
                fixture.queryClient.setQueryData(authStatusQueryKey, statusB);
            });
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(2));
            expect(screen.queryByText("Authenticated browser child")).toBeNull();

            act(() => {
                fixture.queryClient.removeQueries({
                    exact: true,
                    queryKey: authStatusQueryKey,
                });
            });
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(3));

            await act(() => fixture.deferredCollections.release(1));
            expect(screen.queryByText("Authenticated browser child")).toBeNull();

            await act(() => fixture.deferredCollections.release(2));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            await waitFor(() => expect(fixture.releases).toHaveLength(2));
            expect(fixture.releases[1]).toMatchObject({
                authentication: undefined,
                privateValue: undefined,
            });
        } finally {
            await cleanupBoundary(fixture);
        }
    });

    test("does not reset collections or cache for same-session lastSeen changes", async () => {
        const timestampMs = Date.now();
        const status = authenticatedStatus(timestampMs, "a".repeat(32));
        const fixture = renderBoundary(status);

        try {
            await waitFor(() => expect(fixture.deferredCollections.resetCount).toBe(1));
            await act(() => fixture.deferredCollections.release(0));
            expect(await screen.findByText("Authenticated browser child")).toBeTruthy();
            await waitFor(() => expect(fixture.releases).toHaveLength(1));
            const releasedCollections = fixture.sourceCollections.agents;
            const privateValue = { owner: "same-session" };
            fixture.queryClient.setQueryData(privateQueryKey, privateValue);

            await act(async () => {
                fixture.queryClient.setQueryData(authStatusQueryKey, {
                    ...status,
                    session: {
                        ...status.session,
                        lastSeenAtMs: timestampMs + 60_000,
                    },
                });
                await Promise.resolve();
            });

            expect(screen.getByText("Authenticated browser child")).toBeTruthy();
            expect(fixture.deferredCollections.resetCount).toBe(1);
            expect(fixture.sourceCollections.agents).toBe(releasedCollections);
            expect(
                fixture.queryClient.getQueryData<typeof privateValue>(privateQueryKey)
            ).toBe(privateValue);
        } finally {
            await cleanupBoundary(fixture);
        }
    });
});

describe("authenticated browser cache reset", () => {
    test("clears the mutation cache when seeding a known authentication status", async () => {
        const queryClient = createDashboardQueryClient();
        const client = createUnexpectedTrpcClient();
        const collections = createDashboardBrowserCollections(queryClient, client);
        const status = authenticatedStatus(Date.now(), "b".repeat(32));
        queryClient.setQueryData(privateQueryKey, { owner: "previous-session" });
        queryClient.getMutationCache().build(queryClient, {
            mutationFn: () => Promise.resolve("private result"),
            mutationKey: ["private", "mutation"],
        });

        try {
            expect(queryClient.getMutationCache().getAll()).toHaveLength(1);

            await resetAuthenticatedBrowserCache(queryClient, collections, status);

            expect(queryClient.getMutationCache().getAll()).toHaveLength(0);
            expect(queryClient.getQueryData(privateQueryKey)).toBeUndefined();
            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(status);
        } finally {
            await collections.cleanup();
            queryClient.clear();
        }
    });

    test("preserves a fresher authentication status published during reset", async () => {
        const queryClient = createDashboardQueryClient();
        const client = createUnexpectedTrpcClient();
        const sourceCollections = createDashboardBrowserCollections(queryClient, client);
        const deferredCollections = deferCollectionResets(sourceCollections);
        const bootstrapStatus = {
            state: "bootstrap-required",
        } satisfies AuthStatus;
        const anonymousStatus = { state: "anonymous" } satisfies AuthStatus;
        queryClient.setQueryData(authStatusQueryKey, bootstrapStatus);
        const reset = resetAuthenticatedBrowserCache(
            queryClient,
            deferredCollections.collections,
            bootstrapStatus
        );

        try {
            await waitFor(() => expect(deferredCollections.resetCount).toBe(1));
            await act(() => publishAuthenticationStatus(queryClient, anonymousStatus));
            await act(() => deferredCollections.release(0));
            await reset;

            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(anonymousStatus);
        } finally {
            await deferredCollections.releaseAll();
            await sourceCollections.cleanup();
            queryClient.clear();
        }
    });

    test("prevents a cancelled auth request from reviving an older session", async () => {
        const queryClient = createDashboardQueryClient();
        const statusA = authenticatedStatus(Date.now(), "a".repeat(32));
        const anonymousStatus = { state: "anonymous" } satisfies AuthStatus;
        const staleStatus = Promise.withResolvers<AuthStatus>();
        queryClient.setQueryData(authStatusQueryKey, statusA);
        const staleRequest = queryClient.fetchQuery({
            queryFn: () => staleStatus.promise,
            queryKey: authStatusQueryKey,
            staleTime: 0,
        });

        try {
            await waitFor(() => expect(queryClient.isFetching()).toBe(1));
            await act(() => publishAuthenticationStatus(queryClient, anonymousStatus));
            staleStatus.resolve(statusA);
            await staleRequest.catch(() => {});

            expect(queryClient.getQueryData(authStatusQueryKey)).toEqual(anonymousStatus);
        } finally {
            staleStatus.resolve(statusA);
            queryClient.clear();
        }
    });
});
