import { describe, expect, test } from "bun:test";

import { QueryClientProvider } from "@tanstack/react-query";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, useEffect, useState } from "react";

import type { AuthStatus } from "../../contracts/auth.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardTrpcProvider } from "../api/trpcContext.tsx";
import { DashboardBrowserApplication } from "../application.tsx";
import { createDashboardBrowserCollections } from "../data/dashboardCollections.ts";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import { AuthenticationBoundary } from "./AuthenticationBoundary.tsx";
import { authStatusQueryKey } from "./authQueries.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

class DeferredAuthenticationTransport implements DashboardTrpcTransport {
    #statusRequest = Promise.withResolvers<AuthStatus>();
    #statusRequestPending = true;
    #settledStatus: AuthStatus | undefined;
    statusQueryCount = 0;

    mutation(path: string): Promise<unknown> {
        return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    }

    query(path: string): Promise<unknown> {
        if (path !== "auth.status") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        this.statusQueryCount += 1;
        if (this.#statusRequestPending) return this.#statusRequest.promise;
        if (this.#settledStatus === undefined) {
            return Promise.reject(
                new TypeError("Authentication status was not resolved")
            );
        }
        return Promise.resolve(this.#settledStatus);
    }

    deferStatus(): void {
        this.#statusRequest = Promise.withResolvers<AuthStatus>();
        this.#statusRequestPending = true;
    }

    resolveStatus(status: AuthStatus): void {
        this.#settledStatus = status;
        this.#statusRequestPending = false;
        this.#statusRequest.resolve(status);
    }
}

class ProtectedDraftLifecycle {
    activations = 0;
    deactivations = 0;
    mounts = 0;

    activate() {
        this.activations += 1;
    }

    deactivate() {
        this.deactivations += 1;
    }

    mount() {
        this.mounts += 1;
    }
}

function ProtectedDraft({ lifecycle }: { readonly lifecycle: ProtectedDraftLifecycle }) {
    const [draft, setDraft] = useState(() => {
        lifecycle.mount();
        return "";
    });
    useEffect(() => {
        lifecycle.activate();
        return () => {
            lifecycle.deactivate();
        };
    }, [lifecycle]);
    return (
        <label>
            Protected draft
            <input
                onChange={(event) => setDraft(event.currentTarget.value)}
                value={draft}
            />
        </label>
    );
}

describe("authenticated route boundary", () => {
    test("preserves a verified draft while a same-identity check stays fail-closed", async () => {
        const timestampMs = Date.now();
        const queryClient = createDashboardQueryClient();
        const transport = new DeferredAuthenticationTransport();
        const authenticatedStatus = Object.freeze({
            session: {
                authenticatedAtMs: timestampMs,
                authMethod: "password",
                createdAtMs: timestampMs,
                expiresAtMs: timestampMs + 86_400_000,
                id: "a".repeat(32),
                isCurrent: true,
                lastSeenAtMs: timestampMs,
            },
            state: "authenticated",
            user: {
                id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                username: "operator",
            },
        } satisfies AuthStatus);
        queryClient.setQueryData(authStatusQueryKey, authenticatedStatus);
        const trpcClient = createDashboardTrpcClient(transport);
        const lifecycle = new ProtectedDraftLifecycle();
        const view = render(
            <QueryClientProvider client={queryClient}>
                <DashboardTrpcProvider client={trpcClient}>
                    <AuthenticationBoundary>
                        <ProtectedDraft lifecycle={lifecycle} />
                    </AuthenticationBoundary>
                </DashboardTrpcProvider>
            </QueryClientProvider>
        );

        try {
            expect(await screen.findByLabelText("Authentication status")).toBeTruthy();
            expect(lifecycle.mounts).toBe(0);

            await act(async () => {
                transport.resolveStatus(authenticatedStatus);
                await Promise.resolve();
            });
            const draft = await screen.findByRole<HTMLInputElement>("textbox", {
                name: "Protected draft",
            });
            expect(lifecycle).toEqual({
                activations: 1,
                deactivations: 0,
                mounts: 1,
            });
            await userEvent.setup().type(draft, "keep this draft");

            transport.deferStatus();
            let sameIdentityCheck = Promise.resolve();
            act(() => {
                sameIdentityCheck = queryClient.refetchQueries({
                    exact: true,
                    queryKey: authStatusQueryKey,
                });
            });
            expect(await screen.findByLabelText("Authentication status")).toBeTruthy();
            expect(screen.queryByRole("textbox", { name: "Protected draft" })).toBeNull();
            expect(draft.isConnected).toBeTrue();
            expect(draft.value).toBe("keep this draft");
            await waitFor(() => expect(lifecycle.deactivations).toBe(1));

            await act(async () => {
                transport.resolveStatus(authenticatedStatus);
                await sameIdentityCheck;
            });
            expect(await screen.findByRole("textbox", { name: "Protected draft" })).toBe(
                draft
            );
            expect(draft.value).toBe("keep this draft");
            await waitFor(() => expect(lifecycle.activations).toBe(2));

            transport.deferStatus();
            let changedIdentityCheck = Promise.resolve();
            act(() => {
                changedIdentityCheck = queryClient.refetchQueries({
                    exact: true,
                    queryKey: authStatusQueryKey,
                });
            });
            await screen.findByLabelText("Authentication status");
            await act(async () => {
                transport.resolveStatus({
                    ...authenticatedStatus,
                    session: { ...authenticatedStatus.session, id: "b".repeat(32) },
                });
                await changedIdentityCheck;
            });
            await waitFor(() => expect(draft.isConnected).toBeFalse());
            expect(lifecycle.mounts).toBe(1);
            expect(screen.queryByRole("textbox")).toBeNull();
            expect(
                await screen.findByLabelText("Authentication status")
            ).toHaveTextContent("Preparing your session…");
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    test("hides protected content during fresh and background session checks", async () => {
        const timestampMs = Date.now();
        const queryClient = createDashboardQueryClient();
        const transport = new DeferredAuthenticationTransport();
        const cachedAuthenticatedStatus = Object.freeze({
            session: {
                authenticatedAtMs: timestampMs,
                authMethod: "password",
                createdAtMs: timestampMs,
                expiresAtMs: timestampMs + 86_400_000,
                id: "a".repeat(32),
                isCurrent: true,
                lastSeenAtMs: timestampMs,
            },
            state: "authenticated",
            user: {
                id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
                username: "operator",
            },
        } satisfies AuthStatus);
        queryClient.setQueryData(authStatusQueryKey, cachedAuthenticatedStatus);
        const trpcClient = createDashboardTrpcClient(transport);
        const collections = createDashboardBrowserCollections(queryClient, trpcClient);
        const view = render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={createDashboardRouter(
                    createMemoryHistory({ initialEntries: ["/"] })
                )}
                trpcClient={trpcClient}
                webAuthnClient={unexpectedWebAuthnClient}
            />
        );

        try {
            expect(await screen.findByLabelText("Authentication status")).toBeTruthy();
            expect(transport.statusQueryCount).toBeGreaterThan(0);
            expect(
                screen.queryByRole("heading", { level: 1, name: "Mira Dashboard" })
            ).toBeNull();

            await act(async () => {
                transport.resolveStatus(cachedAuthenticatedStatus);
                await Promise.resolve();
            });
            expect(
                await screen.findByRole("heading", {
                    level: 1,
                    name: "Mira Dashboard",
                })
            ).toBeTruthy();

            transport.deferStatus();
            let backgroundCheck = Promise.resolve();
            act(() => {
                backgroundCheck = queryClient.refetchQueries({
                    exact: true,
                    queryKey: authStatusQueryKey,
                });
            });
            expect(await screen.findByLabelText("Authentication status")).toBeTruthy();
            expect(
                screen.queryByRole("heading", { level: 1, name: "Mira Dashboard" })
            ).toBeNull();

            await act(async () => {
                transport.resolveStatus({ state: "anonymous" });
                await backgroundCheck;
            });
            expect(
                await screen.findByRole("heading", { level: 1, name: "Sign in" })
            ).toBeTruthy();
        } finally {
            view.unmount();
            await collections.cleanup();
            queryClient.clear();
        }
    });
});
