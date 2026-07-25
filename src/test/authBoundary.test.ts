import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, jest } from "bun:test";

import {
    AUTH_SESSION_ROTATED_EVENT_NAME,
    AUTH_SESSION_ROTATED_STORAGE_KEY,
    installAuthSessionRotationSync,
    isSignaledAuthSessionRotation,
    notifyAuthSessionRotated,
    recoverOrHandleUnauthorizedSession,
    UNAUTHORIZED_EVENT_NAME,
    uninstallAuthSessionRotationSync,
} from "../lib/authBoundary";
import { authActions, authStore } from "../stores/authStore";

const originalFetch = fetch;

afterEach(() => {
    uninstallAuthSessionRotationSync();
    authActions.clearSession();
    localStorage.removeItem(AUTH_SESSION_ROTATED_STORAGE_KEY);
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
    });
});

describe("Dashboard authentication boundary", () => {
    it("reconnects locally and refreshes session identity after a cross-tab rotation", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T03:59:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: { id: 1, username: "raymond" },
        });
        installAuthSessionRotationSync();
        installAuthSessionRotationSync();
        const rotationHandler = jest.fn();
        addEventListener(AUTH_SESSION_ROTATED_EVENT_NAME, rotationHandler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (String(input) === "/api/auth/session") {
                    return Response.json({
                        authenticated: true,
                        isBootstrapRequired: false,
                        session: {
                            authMethod: "webauthn",
                            expiresAt: "2026-08-24T12:00:00.000Z",
                            lastSeenAt: "2026-07-25T04:00:00.000Z",
                            mfaEnabled: true,
                            sessionId: "22222222222222222222222222222222",
                        },
                        user: { id: 1, username: "raymond" },
                    });
                }
                throw new Error(`Unexpected cross-tab auth request: ${String(input)}`);
            }),
            writable: true,
        });

        try {
            dispatchEvent(
                new StorageEvent("storage", {
                    key: "unrelated-storage-key",
                    newValue: "unrelated-value",
                    storageArea: localStorage,
                })
            );
            dispatchEvent(
                new StorageEvent("storage", {
                    key: AUTH_SESSION_ROTATED_STORAGE_KEY,
                    storageArea: localStorage,
                })
            );
            expect(rotationHandler).not.toHaveBeenCalled();
            expect(fetch).not.toHaveBeenCalled();

            notifyAuthSessionRotated();
            expect(rotationHandler).toHaveBeenCalledTimes(1);
            expect(localStorage.getItem(AUTH_SESSION_ROTATED_STORAGE_KEY)).not.toBeNull();

            dispatchEvent(
                new StorageEvent("storage", {
                    key: AUTH_SESSION_ROTATED_STORAGE_KEY,
                    newValue: "remote-rotation",
                    storageArea: localStorage,
                })
            );

            expect(rotationHandler).toHaveBeenCalledTimes(2);
            await waitFor(() => {
                expect(authStore.state.sessionId).toBe(
                    "22222222222222222222222222222222"
                );
            });
            expect(fetch).toHaveBeenCalledWith("/api/auth/session", {
                credentials: "include",
            });
            expect(
                isSignaledAuthSessionRotation(
                    {
                        sessionId: "11111111111111111111111111111111",
                        userId: 1,
                    },
                    {
                        sessionId: "22222222222222222222222222222222",
                        userId: 1,
                    }
                )
            ).toBe(true);
            expect(
                isSignaledAuthSessionRotation(
                    {
                        sessionId: "11111111111111111111111111111111",
                        userId: 1,
                    },
                    {
                        sessionId: "33333333333333333333333333333333",
                        userId: 1,
                    }
                )
            ).toBe(false);
        } finally {
            removeEventListener(AUTH_SESSION_ROTATED_EVENT_NAME, rotationHandler);
        }
    });

    it("keeps the newest session when overlapping refreshes resolve out of order", async () => {
        const firstResponse = Promise.withResolvers<Response>();
        const secondResponse = Promise.withResolvers<Response>();
        let requestCount = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() => {
                requestCount += 1;
                return requestCount === 1
                    ? firstResponse.promise
                    : secondResponse.promise;
            }),
            writable: true,
        });

        const firstRefresh = authActions.refreshSession();
        const secondRefresh = authActions.refreshSession();
        const observedFirstRefresh = (async () => {
            await firstRefresh;
            return "settled" as const;
        })();
        firstResponse.resolve(
            Response.json({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-25T03:59:00.000Z",
                    mfaEnabled: true,
                    sessionId: "11111111111111111111111111111111",
                },
                user: { id: 1, username: "raymond" },
            })
        );
        await expect(
            Promise.race([
                observedFirstRefresh,
                new Promise<"pending">((resolve) => {
                    queueMicrotask(() => resolve("pending"));
                }),
            ])
        ).resolves.toBe("pending");

        secondResponse.resolve(
            Response.json({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-25T04:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: "22222222222222222222222222222222",
                },
                user: { id: 1, username: "raymond" },
            })
        );
        await Promise.all([firstRefresh, secondRefresh]);

        expect(authStore.state.sessionId).toBe("22222222222222222222222222222222");
    });

    it("uses current auth state after a cross-tab refresh is invalidated", async () => {
        installAuthSessionRotationSync();
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: { id: 1, username: "raymond" },
        });
        const sessionResponse = Promise.withResolvers<Response>();
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() => sessionResponse.promise),
            writable: true,
        });

        try {
            dispatchEvent(
                new StorageEvent("storage", {
                    key: AUTH_SESSION_ROTATED_STORAGE_KEY,
                    newValue: "remote-rotation-without-session",
                    storageArea: localStorage,
                })
            );
            authActions.clearSession();
            sessionResponse.resolve(
                Response.json({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-24T12:00:00.000Z",
                        lastSeenAt: "2026-07-25T04:01:00.000Z",
                        mfaEnabled: true,
                        sessionId: "22222222222222222222222222222222",
                    },
                    user: { id: 1, username: "raymond" },
                })
            );

            await waitFor(() => {
                expect(unauthorizedHandler).toHaveBeenCalledTimes(1);
            });
            expect(authStore.state.isAuthenticated).toBe(false);
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });

    it("does not recover a transport from a refresh invalidated by logout", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            user: { id: 1, username: "raymond" },
        });
        const response = Promise.withResolvers<Response>();
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() => response.promise),
            writable: true,
        });
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);

        try {
            const recovery = recoverOrHandleUnauthorizedSession();
            authActions.clearSession();
            response.resolve(
                Response.json({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-24T12:00:00.000Z",
                        lastSeenAt: "2026-07-25T04:00:00.000Z",
                        mfaEnabled: true,
                        sessionId: "33333333333333333333333333333333",
                    },
                    user: { id: 1, username: "raymond" },
                })
            );

            await expect(recovery).resolves.toBe(false);
            expect(authStore.state.isAuthenticated).toBe(false);
            expect(unauthorizedHandler).toHaveBeenCalledTimes(1);
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });

    it("does not replay after an unsigned same-user session replacement", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: { id: 1, username: "raymond" },
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-24T12:00:00.000Z",
                        lastSeenAt: "2026-07-25T04:01:00.000Z",
                        mfaEnabled: true,
                        sessionId: "22222222222222222222222222222222",
                    },
                    user: { id: 1, username: "raymond" },
                })
            ),
            writable: true,
        });
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);

        try {
            await expect(recoverOrHandleUnauthorizedSession()).resolves.toBe(false);
            expect(authStore.state.isAuthenticated).toBe(true);
            expect(authStore.state.sessionId).toBe("22222222222222222222222222222222");
            expect(unauthorizedHandler).not.toHaveBeenCalled();
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });

    it("preserves a valid session after a transient recovery refresh failure", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: { id: 1, username: "raymond" },
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () => {
                throw new TypeError("Temporary network failure");
            }),
            writable: true,
        });
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);

        try {
            await expect(recoverOrHandleUnauthorizedSession()).resolves.toBe(false);
            expect(fetch).toHaveBeenCalledTimes(1);
            expect(authStore.state.isAuthenticated).toBe(true);
            expect(authStore.state.sessionId).toBe("11111111111111111111111111111111");
            expect(authStore.state.user?.id).toBe(1);
            expect(unauthorizedHandler).not.toHaveBeenCalled();
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });

    it("expires an unclaimed session-rotation signal", () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: { id: 1, username: "raymond" },
        });
        const performanceNow = jest.spyOn(performance, "now");
        performanceNow.mockReturnValue(1000);

        try {
            notifyAuthSessionRotated();
            performanceNow.mockReturnValue(61_001);
            expect(
                isSignaledAuthSessionRotation(
                    {
                        sessionId: "11111111111111111111111111111111",
                        userId: 1,
                    },
                    {
                        sessionId: "22222222222222222222222222222222",
                        userId: 1,
                    }
                )
            ).toBe(false);
        } finally {
            performanceNow.mockRestore();
        }
    });

    it("does not replay an old user's transport after an authenticated identity change", async () => {
        authActions.setSession({
            authenticated: true,
            isBootstrapRequired: false,
            session: {
                authMethod: "webauthn",
                expiresAt: "2026-08-24T12:00:00.000Z",
                lastSeenAt: "2026-07-25T04:00:00.000Z",
                mfaEnabled: true,
                sessionId: "11111111111111111111111111111111",
            },
            user: { id: 1, username: "raymond" },
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async () =>
                Response.json({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-24T12:00:00.000Z",
                        lastSeenAt: "2026-07-25T04:01:00.000Z",
                        mfaEnabled: true,
                        sessionId: "22222222222222222222222222222222",
                    },
                    user: { id: 2, username: "second-user" },
                })
            ),
            writable: true,
        });
        const unauthorizedHandler = jest.fn();
        addEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);

        try {
            await expect(recoverOrHandleUnauthorizedSession()).resolves.toBe(false);
            expect(authStore.state.isAuthenticated).toBe(true);
            expect(authStore.state.user?.id).toBe(2);
            expect(unauthorizedHandler).not.toHaveBeenCalled();
        } finally {
            removeEventListener(UNAUTHORIZED_EVENT_NAME, unauthorizedHandler);
        }
    });

    it("does not restore authentication from a refresh invalidated by logout", async () => {
        const response = Promise.withResolvers<Response>();
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(() => response.promise),
            writable: true,
        });

        const refresh = authActions.refreshSession();
        authActions.clearSession();
        response.resolve(
            Response.json({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-25T04:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: "33333333333333333333333333333333",
                },
                user: { id: 1, username: "raymond" },
            })
        );
        await refresh;

        expect(authStore.state.isAuthenticated).toBe(false);
        expect(authStore.state.sessionId).toBeUndefined();
    });
});
