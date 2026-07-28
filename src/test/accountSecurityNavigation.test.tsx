import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "bun:test";
import type { ReactNode } from "react";

import {
    useConfirmTotpEnrollment,
    useRevokeAllSessions,
    useRevokeSession,
} from "../hooks/useAccountSecurity";
import { ApiError } from "../lib/apiError";
import {
    notifyAuthSessionRotated,
    UNAUTHORIZED_EVENT_NAME,
    uninstallAuthSessionRotationSync,
} from "../lib/authBoundary";
import {
    completeSecurityVerification,
    SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
} from "../lib/securityVerification";
import { authActions, authStore } from "../stores/authStore";

const originalFetch = fetch;

function claimAndCompleteSecurityVerification(event: Event): void {
    event.preventDefault();
    queueMicrotask(completeSecurityVerification);
}

function createQueryHarness() {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { retry: false },
        },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    return { queryClient, wrapper };
}

afterEach(() => {
    uninstallAuthSessionRotationSync();
    authActions.clearSession();
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
    });
});

describe("Account security logout navigation", () => {
    it("routes current-session and all-session revocations through the auth boundary", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                const method = init?.method ?? "GET";
                if (
                    url === "/api/account/security/sessions/current-session" &&
                    method === "DELETE"
                ) {
                    return Response.json({ isOk: true, loggedOut: true });
                }
                if (
                    url === "/api/account/security/sessions/revoke-all" &&
                    method === "POST"
                ) {
                    return Response.json({ isOk: true, revoked: 2 });
                }
                throw new Error(
                    `Unexpected account-security navigation fetch: ${method} ${url}`
                );
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const unauthorizedEvents: Event[] = [];
        const unauthorizedHandler = (event: Event) => {
            unauthorizedEvents.push(event);
        };
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);

        const { queryClient, wrapper } = createQueryHarness();
        const view = renderHook(
            () => ({
                revokeAll: useRevokeAllSessions(),
                revokeCurrent: useRevokeSession(),
            }),
            { wrapper }
        );

        try {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                user: { id: 1, username: "raymond" },
            });
            await act(async () => {
                await view.result.current.revokeCurrent.mutateAsync("current-session");
            });
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedEvents).toHaveLength(1);

            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                user: { id: 1, username: "raymond" },
            });
            await act(async () => {
                await view.result.current.revokeAll.mutateAsync();
            });
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedEvents).toHaveLength(2);
        } finally {
            view.unmount();
            queryClient.clear();
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });

    it("does not replay a current-session selector after step-up rotates it", async () => {
        const currentSessionId = "0123456789abcdef0123456789abcdef";
        let revokeRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    if (
                        String(input) ===
                            `/api/account/security/sessions/${currentSessionId}` &&
                        init?.method === "DELETE"
                    ) {
                        revokeRequests += 1;
                        return revokeRequests === 1
                            ? Response.json(
                                  {
                                      error: {
                                          code: "recent_verification_required",
                                          message: "Recent verification is required",
                                          requestId: "security-session-step-up",
                                      },
                                  },
                                  { status: 403 }
                              )
                            : Response.json({ isOk: true, loggedOut: true });
                    }
                    throw new Error(
                        `Unexpected current-session replay request: ${
                            init?.method ?? "GET"
                        } ${String(input)}`
                    );
                }
            ),
            writable: true,
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-24T12:00:00.000Z",
                mfaEnabled: true,
                sessionId: currentSessionId,
            },
            user: { id: 1, username: "raymond" },
        });
        addEventListener(
            SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
            claimAndCompleteSecurityVerification
        );
        const { queryClient, wrapper } = createQueryHarness();
        const view = renderHook(() => useRevokeSession(), { wrapper });

        try {
            let revokeError: unknown;
            await act(async () => {
                try {
                    await view.result.current.mutateAsync(currentSessionId);
                } catch (error) {
                    revokeError = error;
                }
            });
            expect(revokeError).toBeInstanceOf(ApiError);
            expect(revokeRequests).toBe(1);
            expect(authStore.state.isAuthenticated).toBe(true);
        } finally {
            view.unmount();
            queryClient.clear();
            removeEventListener(
                SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
                claimAndCompleteSecurityVerification
            );
        }
    });

    it("does not replay a current-session selector after stale-401 recovery", async () => {
        const currentSessionId = "0123456789abcdef0123456789abcdef";
        const rotatedSessionId = "fedcba9876543210fedcba9876543210";
        let revokeRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    if (
                        String(input) ===
                            `/api/account/security/sessions/${currentSessionId}` &&
                        init?.method === "DELETE"
                    ) {
                        revokeRequests += 1;
                        return Response.json(
                            {
                                error: {
                                    code: "unauthorized",
                                    message: "Unauthorized",
                                    requestId: "security-session-unauthorized",
                                },
                            },
                            { status: 401 }
                        );
                    }
                    if (String(input) === "/api/auth/session") {
                        return Response.json({
                            authenticated: true,
                            isBootstrapRequired: false,
                            session: {
                                authMethod: "webauthn",
                                expiresAt: "2026-08-24T12:00:00.000Z",
                                lastSeenAt: "2026-07-24T12:01:00.000Z",
                                mfaEnabled: true,
                                sessionId: rotatedSessionId,
                            },
                            user: { id: 1, username: "raymond" },
                        });
                    }
                    throw new Error(
                        `Unexpected current-session auth recovery request: ${
                            init?.method ?? "GET"
                        } ${String(input)}`
                    );
                }
            ),
            writable: true,
        });
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-24T12:00:00.000Z",
                mfaEnabled: true,
                sessionId: currentSessionId,
            },
            user: { id: 1, username: "raymond" },
        });
        const { queryClient, wrapper } = createQueryHarness();
        const view = renderHook(() => useRevokeSession(), { wrapper });

        try {
            notifyAuthSessionRotated();
            let revokeError: unknown;
            await act(async () => {
                try {
                    await view.result.current.mutateAsync(currentSessionId);
                } catch (error) {
                    revokeError = error;
                }
            });
            expect(revokeError).toBeInstanceOf(ApiError);
            expect(revokeRequests).toBe(1);
            expect(authStore.state.sessionId).toBe(rotatedSessionId);
        } finally {
            view.unmount();
            queryClient.clear();
        }
    });

    it("does not replay an expiring TOTP enrollment code after verification", async () => {
        let confirmationRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    if (
                        String(input) === "/api/account/security/totp/confirm" &&
                        init?.method === "POST"
                    ) {
                        confirmationRequests += 1;
                        return confirmationRequests === 1
                            ? Response.json(
                                  {
                                      error: {
                                          code: "recent_verification_required",
                                          message: "Recent verification is required",
                                          requestId: "security-totp-step-up",
                                      },
                                  },
                                  { status: 403 }
                              )
                            : Response.json({
                                  factorId: "01900000-0000-7000-8000-000000000099",
                                  isOk: true,
                                  sessionRotated: true,
                              });
                    }
                    throw new Error(
                        `Unexpected TOTP confirmation replay request: ${
                            init?.method ?? "GET"
                        } ${String(input)}`
                    );
                }
            ),
            writable: true,
        });
        const verificationHandler = jest.fn(claimAndCompleteSecurityVerification);
        addEventListener(SECURITY_VERIFICATION_REQUIRED_EVENT_NAME, verificationHandler);
        const { queryClient, wrapper } = createQueryHarness();
        const view = renderHook(() => useConfirmTotpEnrollment(), { wrapper });

        try {
            let confirmationError: unknown;
            await act(async () => {
                try {
                    await view.result.current.mutateAsync({
                        code: "123456",
                        factorId: "01900000-0000-7000-8000-000000000099",
                    });
                } catch (error) {
                    confirmationError = error;
                }
            });
            expect(confirmationError).toBeInstanceOf(ApiError);
            expect(confirmationRequests).toBe(1);
            expect(verificationHandler).toHaveBeenCalledTimes(1);
        } finally {
            view.unmount();
            queryClient.clear();
            removeEventListener(
                SECURITY_VERIFICATION_REQUIRED_EVENT_NAME,
                verificationHandler
            );
        }
    });
});
