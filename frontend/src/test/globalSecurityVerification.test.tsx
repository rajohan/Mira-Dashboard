import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import type { AccountSecuritySummary } from "../../../contracts/accountSecurity";
import { parseJsonText, requestUrl } from "../../../test/support/fetch";
import { GlobalSecurityVerification } from "../components/features/settings/GlobalSecurityVerification";
import { accountSecurityKeys } from "../hooks/useAccountSecurity";
import {
    AUTH_SESSION_ROTATED_EVENT_NAME,
    uninstallAuthSessionRotationSync,
} from "../lib/authBoundary";
import {
    cancelSecurityVerification,
    completeSecurityVerification,
    dispatchSecurityVerificationRequired,
    type SecurityVerificationCode,
    waitForSecurityVerification,
    waitForSecurityVerificationOutcome,
} from "../lib/securityVerification";
import { authActions, authStore } from "../stores/authStore";
import { createWebAuthnBrowserTestHarness } from "./webAuthnBrowserTestHelper";

const originalFetch = fetch;
const webAuthnBrowser = createWebAuthnBrowserTestHarness();
const PRIMARY_DASHBOARD_SESSION_ID = "11111111111111111111111111111111";
const SECONDARY_DASHBOARD_SESSION_ID = "22222222222222222222222222222222";
const VERIFIED_AT = "2026-07-24T12:05:00.000Z";

function dashboardSession(sessionId: string): AccountSecuritySummary["sessions"][number] {
    return {
        authMethod: "webauthn",
        authenticatedAt: "2026-07-24T12:00:00.000Z",
        createdAt: "2026-07-24T12:00:00.000Z",
        expiresAt: "2026-08-24T12:00:00.000Z",
        isCurrent: true,
        lastSeenAt: "2026-07-24T12:00:00.000Z",
        mfaVerifiedAt: "2026-07-24T12:00:00.000Z",
        sessionId,
    };
}

const securitySummary: AccountSecuritySummary = {
    factors: {
        enabledAt: "2026-07-24T12:00:00.000Z",
        methods: ["webauthn", "totp", "recovery"],
        recoveryCodesRemaining: 8,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentVerification: {
        mfa: true,
        mfaRemainingMs: 60 * 60_000,
        mfaUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
        password: false,
    },
    recommendation: {
        minimumSecurityKeys: 2,
        needsBackupSecurityKey: true,
    },
    sessions: [dashboardSession(PRIMARY_DASHBOARD_SESSION_ID)],
    totp: { available: true },
    webAuthn: {
        available: true,
        rpId: "dashboard.example.com",
    },
};

const passwordOnlySecuritySummary: AccountSecuritySummary = {
    ...securitySummary,
    factors: {
        methods: [],
        recoveryCodesRemaining: 0,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentVerification: {
        mfa: false,
        password: false,
    },
};

function renderVerification() {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { retry: false },
        },
    });
    const view = render(
        <QueryClientProvider client={queryClient}>
            <GlobalSecurityVerification />
        </QueryClientProvider>
    );
    return { ...view, queryClient };
}

function dispatchVerificationRequired(code: SecurityVerificationCode): void {
    act(() => {
        dispatchSecurityVerificationRequired(code);
    });
}

beforeEach(() => {
    authActions.setSession({
        authenticated: true,
        isBootstrapRequired: false,
        session: {
            authMethod: "webauthn",
            expiresAt: "2026-08-24T12:00:00.000Z",
            lastSeenAt: "2026-07-24T12:00:00.000Z",
            mfaEnabled: true,
            sessionId: PRIMARY_DASHBOARD_SESSION_ID,
        },
        user: { id: 1, username: "raymond" },
    });
});

afterEach(() => {
    uninstallAuthSessionRotationSync();
    act(() => {
        authActions.clearSession();
    });
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
    });
    webAuthnBrowser.restore();
});

describe("Global security verification", () => {
    it("requires step-up when the server expiry is malformed", async () => {
        const malformedSummary: AccountSecuritySummary = {
            ...securitySummary,
            recentVerification: {
                mfa: true,
                mfaUntil: "not-a-timestamp",
                password: false,
            },
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(malformedSummary);
                    }
                    throw new Error(
                        `Unexpected malformed-expiry request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        expect(
            await screen.findByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();
        act(() => {
            cancelSecurityVerification();
            queryClient.clear();
        });
    });

    it("uses the server-relative MFA lifetime instead of the client clock", async () => {
        const serverFreshSummary: AccountSecuritySummary = {
            ...securitySummary,
            recentVerification: {
                mfa: true,
                mfaRemainingMs: 60_000,
                mfaUntil: "2020-01-01T00:00:00.000Z",
                password: false,
            },
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(serverFreshSummary);
                    }
                    throw new Error(
                        `Unexpected server-relative deadline request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(
                queryClient.getQueryData<AccountSecuritySummary>(
                    accountSecurityKeys.session(1, PRIMARY_DASHBOARD_SESSION_ID)
                )
            ).toEqual(serverFreshSummary);
        });
        expect(
            screen.queryByRole("heading", { name: "Verify your session" })
        ).not.toBeInTheDocument();
        act(() => {
            queryClient.clear();
        });
    });

    it("does not trust a security summary without a matching local session id", async () => {
        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: "session-other",
                },
                user: { id: 1, username: "raymond" },
            });
        });
        const expiredSummary: AccountSecuritySummary = {
            ...securitySummary,
            recentVerification: {
                mfa: false,
                password: false,
            },
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(expiredSummary);
                    }
                    throw new Error(
                        `Unexpected missing-session-id request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        expect(
            screen.queryByRole("heading", { name: "Verify your session" })
        ).not.toBeInTheDocument();
        act(() => {
            queryClient.clear();
        });
    });

    it("opens proactively without resetting an in-progress verification", async () => {
        const expiringSummary: AccountSecuritySummary = {
            ...securitySummary,
            recentVerification: {
                ...securitySummary.recentVerification,
                mfaRemainingMs: 0,
                mfaUntil: new Date(Date.now() - 1000).toISOString(),
            },
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(expiringSummary);
                    }
                    throw new Error(`Unexpected proactive request: ${requestUrl(input)}`);
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        expect(
            await screen.findByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
        await userEvent.type(
            screen.getByLabelText("Recovery code"),
            "preserve-this-code"
        );
        await act(async () => {
            queryClient.setQueryData(
                accountSecurityKeys.session(1, PRIMARY_DASHBOARD_SESSION_ID),
                {
                    ...expiringSummary,
                    factors: {
                        ...expiringSummary.factors,
                        recoveryCodesRemaining: 7,
                    },
                    recentVerification: {
                        ...expiringSummary.recentVerification,
                    },
                }
            );
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(screen.getByLabelText("Recovery code")).toHaveValue("preserve-this-code");
        await userEvent.click(
            screen.getByRole("button", { name: "Close Verify your session" })
        );
        act(() => {
            queryClient.clear();
        });
    });

    it("refetches verification deadlines after the authenticated user changes", async () => {
        const expiredSummary: AccountSecuritySummary = {
            ...securitySummary,
            factors: {
                ...securitySummary.factors,
                methods: ["recovery"],
            },
            recentVerification: {
                mfa: false,
                password: false,
            },
        };
        const secondSecurityResponse = Promise.withResolvers<Response>();
        const secondSecuritySummary = {
            ...securitySummary,
            sessions: [dashboardSession(SECONDARY_DASHBOARD_SESSION_ID)],
        };
        let securityRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (requestUrl(input) === "/api/account/security") {
                    securityRequests += 1;
                    return securityRequests === 1
                        ? Response.json(expiredSummary)
                        : secondSecurityResponse.promise;
                }
                throw new Error(`Unexpected user-switch request: ${requestUrl(input)}`);
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        expect(
            await screen.findByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: "Close Verify your session" })
        );
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });

        act(() => {
            authActions.clearSession();
        });
        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 2, username: "second-user" },
            });
        });

        await waitFor(() => {
            expect(securityRequests).toBe(2);
        });
        await act(async () => {
            secondSecurityResponse.resolve(Response.json(secondSecuritySummary));
            await secondSecurityResponse.promise;
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(
            screen.queryByRole("heading", { name: "Verify your session" })
        ).not.toBeInTheDocument();
        act(() => {
            queryClient.clear();
        });
    });

    it("refetches verification deadlines when the same user starts a new session", async () => {
        const expiredSummary: AccountSecuritySummary = {
            ...securitySummary,
            factors: {
                ...securitySummary.factors,
                methods: ["recovery"],
            },
            recentVerification: {
                mfa: false,
                password: false,
            },
        };
        const secondSecuritySummary = {
            ...securitySummary,
            sessions: [dashboardSession(SECONDARY_DASHBOARD_SESSION_ID)],
        };
        let securityRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        securityRequests += 1;
                        return Response.json(
                            securityRequests === 1
                                ? expiredSummary
                                : secondSecuritySummary
                        );
                    }
                    throw new Error(
                        `Unexpected same-user session request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        expect(
            await screen.findByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: "Close Verify your session" })
        );
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });

        act(() => {
            authActions.clearSession();
        });
        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 1, username: "raymond" },
            });
        });

        await waitFor(() => {
            expect(securityRequests).toBe(2);
        });
        expect(
            screen.queryByRole("heading", { name: "Verify your session" })
        ).not.toBeInTheDocument();
        act(() => {
            queryClient.clear();
        });
    });

    it("ignores a security summary from a different auth session", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(securitySummary);
                    }
                    throw new Error(
                        `Unexpected auth-snapshot request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        act(() => {
            queryClient.setQueryData(
                accountSecurityKeys.session(1, PRIMARY_DASHBOARD_SESSION_ID),
                {
                    ...securitySummary,
                    recentVerification: {
                        mfa: false,
                        password: false,
                    },
                    sessions: [dashboardSession(SECONDARY_DASHBOARD_SESSION_ID)],
                }
            );
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.body).not.toHaveTextContent(/Verify your session/);
        act(() => {
            queryClient.clear();
        });
    });

    it("uses the coherent security summary when MFA is disabled", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(securitySummary);
                    }
                    throw new Error(
                        `Unexpected disabled-MFA snapshot request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        act(() => {
            queryClient.setQueryData(
                accountSecurityKeys.session(1, PRIMARY_DASHBOARD_SESSION_ID),
                {
                    ...passwordOnlySecuritySummary,
                    sessions: [dashboardSession(PRIMARY_DASHBOARD_SESSION_ID)],
                }
            );
        });

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(document.body).not.toHaveTextContent(/Verify your session/);
        act(() => {
            queryClient.clear();
        });
    });

    it("directs enrollment-required actions to Dashboard security settings", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(securitySummary);
                    }
                    throw new Error(
                        `Unexpected enrollment request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        dispatchVerificationRequired("mfa_enrollment_required");

        expect(
            screen.getByRole("heading", { name: "Protect privileged actions" })
        ).toBeInTheDocument();
        expect(
            screen.getByRole("button", {
                name: "Open Dashboard security settings",
            })
        ).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", {
                name: "Close Protect privileged actions",
            })
        );
        expect(
            screen.queryByRole("heading", { name: "Protect privileged actions" })
        ).not.toBeInTheDocument();
        act(() => {
            queryClient.clear();
        });
    });

    it("closes the shared dialog when the verification flow is cancelled", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(securitySummary);
                    }
                    throw new Error(
                        `Unexpected cancellation request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        dispatchVerificationRequired("step_up_required");
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        act(() => {
            cancelSecurityVerification();
        });
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("cancels a claimed verification when authentication ends", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(securitySummary);
                    }
                    throw new Error(
                        `Unexpected logout cancellation request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        let verificationPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        act(() => {
            authActions.clearSession();
        });

        expect(verificationPromise).resolves.toBe("cancelled");
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("cancels held actions when the authenticated identity changes", async () => {
        const secondSecuritySummary: AccountSecuritySummary = {
            ...securitySummary,
            sessions: [dashboardSession(SECONDARY_DASHBOARD_SESSION_ID)],
        };
        let securityRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        securityRequests += 1;
                        return Response.json(
                            securityRequests === 1
                                ? securitySummary
                                : secondSecuritySummary
                        );
                    }
                    throw new Error(
                        `Unexpected authenticated-identity request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(securityRequests).toBe(1);
        });
        let verificationPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 2, username: "second-user" },
            });
        });

        expect(verificationPromise).resolves.toBe("cancelled");
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("cancels held actions after an unannounced same-user session change", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(securitySummary);
                    }
                    throw new Error(
                        `Unexpected unannounced-session request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(
                queryClient.getQueryData<AccountSecuritySummary>(
                    accountSecurityKeys.session(1, PRIMARY_DASHBOARD_SESSION_ID)
                )
            ).toEqual(securitySummary);
        });
        let verificationPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:01:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 1, username: "raymond" },
            });
        });

        expect(verificationPromise).resolves.toBe("cancelled");
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("releases step-up waiters after a verified cross-tab session rotation", async () => {
        const rotatedSecuritySummary: AccountSecuritySummary = {
            ...securitySummary,
            sessions: [dashboardSession(SECONDARY_DASHBOARD_SESSION_ID)],
        };
        const rotatedSecurityResponse = Promise.withResolvers<Response>();
        let securityRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (requestUrl(input) === "/api/account/security") {
                    securityRequests += 1;
                    return securityRequests === 1
                        ? Response.json(securitySummary)
                        : rotatedSecurityResponse.promise;
                }
                throw new Error(
                    `Unexpected cross-tab completion request: ${requestUrl(input)}`
                );
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(securityRequests).toBe(1);
        });
        let verificationPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        act(() => {
            dispatchEvent(new Event(AUTH_SESSION_ROTATED_EVENT_NAME));
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:01:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 1, username: "raymond" },
            });
        });

        await waitFor(() => {
            expect(securityRequests).toBe(2);
        });
        await act(async () => {
            rotatedSecurityResponse.resolve(Response.json(rotatedSecuritySummary));
            await rotatedSecurityResponse.promise;
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(verificationPromise).resolves.toBe("verified");
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("does not claim an incompatible requirement during an active flow", async () => {
        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "password",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: false,
                    sessionId: PRIMARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 1, username: "raymond" },
            });
        });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn((input: RequestInfo | URL) => {
                return Promise.try(() => {
                    if (requestUrl(input) === "/api/account/security") {
                        return Response.json(passwordOnlySecuritySummary);
                    }
                    throw new Error(
                        `Unexpected incompatible verification request: ${requestUrl(input)}`
                    );
                });
            }),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/account/security",
                expect.objectContaining({ credentials: "include" })
            );
        });
        let passwordPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        let enrollmentPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            passwordPromise = waitForSecurityVerificationOutcome(
                "recent_verification_required"
            );
            enrollmentPromise = waitForSecurityVerificationOutcome(
                "mfa_enrollment_required"
            );
        });
        expect(
            screen.getByRole("heading", { name: "Verify current password" })
        ).toBeInTheDocument();

        act(() => {
            completeSecurityVerification();
        });

        expect(passwordPromise).resolves.toBe("verified");
        expect(enrollmentPromise).resolves.toBe("unclaimed");
        act(() => {
            cancelSecurityVerification();
            queryClient.clear();
        });
    });

    it("ignores a late mutation completion from a cancelled auth generation", async () => {
        const recoveryResponse = Promise.withResolvers<Response>();
        const secondarySecuritySummary = {
            ...securitySummary,
            sessions: [dashboardSession(SECONDARY_DASHBOARD_SESSION_ID)],
        };
        let securityRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (url === "/api/account/security" && method === "GET") {
                        securityRequests += 1;
                        return Response.json(
                            securityRequests === 1
                                ? securitySummary
                                : secondarySecuritySummary
                        );
                    }
                    if (
                        url === "/api/account/security/step-up/recovery" &&
                        method === "POST"
                    ) {
                        return recoveryResponse.promise;
                    }
                    if (url === "/api/auth/session" && method === "GET") {
                        return Response.json({
                            authenticated: true,
                            isBootstrapRequired: false,
                            session: {
                                authMethod: "webauthn",
                                expiresAt: "2026-08-24T12:00:00.000Z",
                                lastSeenAt: "2026-07-24T12:00:00.000Z",
                                mfaEnabled: true,
                                sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                            },
                            user: { id: 1, username: "raymond" },
                        });
                    }
                    throw new Error(
                        `Unexpected stale-generation request: ${method} ${url}`
                    );
                }
            ),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(securityRequests).toBe(1);
        });
        let cancelledPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            cancelledPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        await userEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
        await userEvent.type(screen.getByLabelText("Recovery code"), "old-session-code");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Close Verify your session",
                })
            ).toBeDisabled();
        });

        act(() => {
            authActions.clearSession();
        });
        expect(cancelledPromise).resolves.toBe("cancelled");
        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 1, username: "raymond" },
            });
        });
        await waitFor(() => {
            expect(securityRequests).toBe(2);
        });

        let nextPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        let nextOutcome = "pending";
        act(() => {
            const verificationPromise =
                waitForSecurityVerificationOutcome("step_up_required");
            nextPromise = verificationPromise;
            void (async () => {
                nextOutcome = await verificationPromise;
            })();
        });
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        await act(async () => {
            recoveryResponse.resolve(
                Response.json({
                    isOk: true,
                    method: "recovery",
                    verifiedAt: VERIFIED_AT,
                })
            );
            await recoveryResponse.promise;
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        await waitFor(() => {
            expect(fetch).toHaveBeenCalledWith(
                "/api/auth/session",
                expect.objectContaining({ credentials: "include" })
            );
        });

        expect(nextOutcome).toBe("pending");
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();
        act(() => {
            cancelSecurityVerification();
        });
        expect(nextPromise).resolves.toBe("cancelled");
        act(() => {
            queryClient.clear();
        });
    });

    it("refreshes auth identity before releasing a successful step-up", async () => {
        const firstSessionResponse = Promise.withResolvers<Response>();
        let recoveryRequests = 0;
        let sessionRequests = 0;
        const secondUserSession = () =>
            Response.json({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "webauthn",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:01:00.000Z",
                    mfaEnabled: true,
                    sessionId: SECONDARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 2, username: "second-user" },
            });
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (url === "/api/account/security" && method === "GET") {
                        return Response.json(securitySummary);
                    }
                    if (
                        url === "/api/account/security/step-up/recovery" &&
                        method === "POST"
                    ) {
                        recoveryRequests += 1;
                        return Response.json({
                            isOk: true,
                            method: "recovery",
                            verifiedAt: VERIFIED_AT,
                        });
                    }
                    if (url === "/api/auth/session" && method === "GET") {
                        sessionRequests += 1;
                        if (sessionRequests === 1) {
                            return firstSessionResponse.promise;
                        }
                        firstSessionResponse.resolve(secondUserSession());
                        return secondUserSession();
                    }
                    throw new Error(
                        `Unexpected identity-refresh request: ${method} ${url}`
                    );
                }
            ),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalled();
        });
        let verificationPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        await userEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
        await userEvent.type(screen.getByLabelText("Recovery code"), "single-use-code");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));

        expect(verificationPromise).resolves.toBe("cancelled");
        expect(recoveryRequests).toBe(1);
        expect(sessionRequests).toBe(2);
        expect(authStore.state.isAuthenticated).toBe(true);
        expect(authStore.state.user?.id).toBe(2);
        expect(authStore.state.sessionId).toBe(SECONDARY_DASHBOARD_SESSION_ID);
        act(() => {
            queryClient.clear();
        });
    });

    it("prevents dismissal while a recovery verification is pending", async () => {
        const recoveryResponse = Promise.withResolvers<Response>();
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    const url = requestUrl(input);
                    const method = init?.method ?? "GET";
                    if (url === "/api/account/security" && method === "GET") {
                        return Response.json(securitySummary);
                    }
                    if (
                        url === "/api/account/security/step-up/recovery" &&
                        method === "POST"
                    ) {
                        return recoveryResponse.promise;
                    }
                    if (url === "/api/auth/session" && method === "GET") {
                        return Response.json({
                            authenticated: true,
                            isBootstrapRequired: false,
                            session: {
                                authMethod: "webauthn",
                                expiresAt: "2026-08-24T12:00:00.000Z",
                                lastSeenAt: "2026-07-24T12:00:00.000Z",
                                mfaEnabled: true,
                                sessionId: PRIMARY_DASHBOARD_SESSION_ID,
                            },
                            user: { id: 1, username: "raymond" },
                        });
                    }
                    throw new Error(
                        `Unexpected pending verification request: ${method} ${url}`
                    );
                }
            ),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalled();
        });
        let verificationPromise: Promise<boolean> | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerification("step_up_required");
        });
        await userEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
        await userEvent.type(screen.getByLabelText("Recovery code"), "single-use-code");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));

        await waitFor(() => {
            expect(
                screen.getByRole("button", {
                    name: "Close Verify your session",
                })
            ).toBeDisabled();
        });
        await userEvent.click(
            screen.getByRole("button", {
                name: "Close Verify your session",
            })
        );
        await userEvent.keyboard("{Escape}");
        const backdrop = [...document.querySelectorAll<HTMLElement>("div")].find(
            (element) => element.classList.contains("bg-black/50")
        );
        if (!backdrop) {
            throw new Error("Expected the verification modal backdrop");
        }
        await userEvent.click(backdrop);
        expect(
            screen.getByRole("heading", { name: "Verify your session" })
        ).toBeInTheDocument();

        await act(async () => {
            recoveryResponse.resolve(
                Response.json({
                    isOk: true,
                    method: "recovery",
                    verifiedAt: VERIFIED_AT,
                })
            );
            await verificationPromise;
        });
        expect(await verificationPromise).toBe(true);
        await waitFor(() => {
            expect(document.body).not.toHaveTextContent(/Verify your session/);
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("offers password reauthentication when MFA is not enabled", async () => {
        act(() => {
            authActions.setSession({
                authenticated: true,
                isBootstrapRequired: false,
                session: {
                    authMethod: "password",
                    expiresAt: "2026-08-24T12:00:00.000Z",
                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                    mfaEnabled: false,
                    sessionId: PRIMARY_DASHBOARD_SESSION_ID,
                },
                user: { id: 1, username: "raymond" },
            });
        });
        const passwordCalls: Array<{
            body: unknown;
            method: string;
            url: string;
        }> = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                    return Promise.try(() => {
                        const url = requestUrl(input);
                        const method = init?.method ?? "GET";
                        const body =
                            typeof init?.body === "string"
                                ? parseJsonText(init.body)
                                : undefined;
                        passwordCalls.push({ body, method, url });

                        if (url === "/api/account/security" && method === "GET") {
                            return Response.json(passwordOnlySecuritySummary);
                        }
                        if (
                            url === "/api/account/security/reauth/password" &&
                            method === "POST"
                        ) {
                            return Response.json({
                                isOk: true,
                                verifiedAt: VERIFIED_AT,
                            });
                        }
                        if (url === "/api/auth/session" && method === "GET") {
                            return Response.json({
                                authenticated: true,
                                isBootstrapRequired: false,
                                session: {
                                    authMethod: "password",
                                    expiresAt: "2026-08-24T12:00:00.000Z",
                                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                                    mfaEnabled: false,
                                    sessionId: PRIMARY_DASHBOARD_SESSION_ID,
                                },
                                user: { id: 1, username: "raymond" },
                            });
                        }
                        throw new Error(
                            `Unexpected password verification request: ${method} ${url}`
                        );
                    });
                }
            ),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalled();
        });

        dispatchVerificationRequired("recent_verification_required");
        expect(
            screen.getByRole("heading", { name: "Verify current password" })
        ).toBeInTheDocument();
        await userEvent.type(
            screen.getByLabelText("Current password"),
            "current-password"
        );
        await act(async () => {
            screen.getByRole("button", { name: "Verify" }).click();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        await waitFor(() =>
            expect(
                screen.queryByRole("heading", { name: "Verify current password" })
            ).not.toBeInTheDocument()
        );
        expect(passwordCalls).toContainEqual({
            body: { password: "current-password" },
            method: "POST",
            url: "/api/account/security/reauth/password",
        });
        act(() => {
            queryClient.clear();
        });
    });

    it("does not replay a session-bound WebAuthn assertion after a 401", async () => {
        webAuthnBrowser.install();
        let authSessionRequests = 0;
        let verifyRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                    return Promise.try(() => {
                        const url = requestUrl(input);
                        const method = init?.method ?? "GET";
                        if (url === "/api/account/security" && method === "GET") {
                            return Response.json(securitySummary);
                        }
                        if (
                            url === "/api/account/security/step-up/webauthn/options" &&
                            method === "POST"
                        ) {
                            return Response.json({
                                options: {
                                    allowCredentials: [
                                        {
                                            id: "AQID",
                                            transports: ["usb"],
                                            type: "public-key",
                                        },
                                    ],
                                    challenge: "AA",
                                    rpId: "dashboard.example.com",
                                    timeout: 60_000,
                                    userVerification: "required",
                                },
                            });
                        }
                        if (
                            url === "/api/account/security/step-up/webauthn/verify" &&
                            method === "POST"
                        ) {
                            verifyRequests += 1;
                            return Response.json(
                                {
                                    error: {
                                        code: "unauthorized",
                                        message: "Session changed",
                                        requestId: "security-session-changed",
                                    },
                                },
                                { status: 401 }
                            );
                        }
                        if (url === "/api/auth/session" && method === "GET") {
                            authSessionRequests += 1;
                            return Response.json({
                                authenticated: true,
                                isBootstrapRequired: false,
                                session: {
                                    authMethod: "webauthn",
                                    expiresAt: "2026-08-24T12:00:00.000Z",
                                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                                    mfaEnabled: true,
                                    sessionId: PRIMARY_DASHBOARD_SESSION_ID,
                                },
                                user: { id: 1, username: "raymond" },
                            });
                        }
                        throw new Error(
                            `Unexpected WebAuthn replay request: ${method} ${url}`
                        );
                    });
                }
            ),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalled();
        });
        let verificationPromise:
            | ReturnType<typeof waitForSecurityVerificationOutcome>
            | undefined;
        act(() => {
            verificationPromise = waitForSecurityVerificationOutcome("step_up_required");
        });
        await userEvent.click(screen.getByRole("button", { name: "Use security key" }));

        expect(await screen.findByText("Unauthorized")).toBeInTheDocument();
        expect(verifyRequests).toBe(1);
        expect(authSessionRequests).toBe(1);
        act(() => {
            cancelSecurityVerification();
        });
        expect(verificationPromise).resolves.toBe("cancelled");
        act(() => {
            queryClient.clear();
        });
    });

    it("handles recovery, TOTP, and security-key step-up ceremonies", async () => {
        webAuthnBrowser.install();
        const calls: Array<{ body: unknown; method: string; url: string }> = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
                    return Promise.try(() => {
                        const url = requestUrl(input);
                        const method = init?.method ?? "GET";
                        const body =
                            typeof init?.body === "string"
                                ? parseJsonText(init.body)
                                : undefined;
                        calls.push({ body, method, url });

                        if (url === "/api/account/security" && method === "GET") {
                            return Response.json(securitySummary);
                        }
                        if (url === "/api/auth/session" && method === "GET") {
                            return Response.json({
                                authenticated: true,
                                isBootstrapRequired: false,
                                session: {
                                    authMethod: "webauthn",
                                    expiresAt: "2026-08-24T12:00:00.000Z",
                                    lastSeenAt: "2026-07-24T12:00:00.000Z",
                                    mfaEnabled: true,
                                    sessionId: PRIMARY_DASHBOARD_SESSION_ID,
                                },
                                user: { id: 1, username: "raymond" },
                            });
                        }
                        if (
                            url === "/api/account/security/step-up/recovery" &&
                            method === "POST"
                        ) {
                            return (body as { code?: string }).code === "valid-recovery"
                                ? Response.json({
                                      isOk: true,
                                      method: "recovery",
                                      verifiedAt: VERIFIED_AT,
                                  })
                                : Response.json(
                                      {
                                          error: {
                                              code: "invalid_request",
                                              message: "Invalid recovery code",
                                              requestId: "security-invalid-recovery",
                                          },
                                      },
                                      { status: 400 }
                                  );
                        }
                        if (
                            url === "/api/account/security/step-up/totp" &&
                            method === "POST"
                        ) {
                            return Response.json({
                                isOk: true,
                                method: "totp",
                                verifiedAt: VERIFIED_AT,
                            });
                        }
                        if (
                            url === "/api/account/security/step-up/webauthn/options" &&
                            method === "POST"
                        ) {
                            return Response.json({
                                options: {
                                    allowCredentials: [
                                        {
                                            id: "AQID",
                                            transports: ["usb"],
                                            type: "public-key",
                                        },
                                    ],
                                    challenge: "AA",
                                    rpId: "dashboard.example.com",
                                    timeout: 60_000,
                                    userVerification: "required",
                                },
                            });
                        }
                        if (
                            url === "/api/account/security/step-up/webauthn/verify" &&
                            method === "POST"
                        ) {
                            return Response.json({
                                isOk: true,
                                method: "webauthn",
                                verifiedAt: VERIFIED_AT,
                            });
                        }
                        throw new Error(
                            `Unexpected global verification request: ${method} ${url}`
                        );
                    });
                }
            ),
            writable: true,
        });

        const { queryClient } = renderVerification();
        await waitFor(() => {
            expect(fetch).toHaveBeenCalled();
        });

        dispatchVerificationRequired("step_up_required");
        await userEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
        await userEvent.type(screen.getByLabelText("Recovery code"), "invalid-recovery");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        expect(await screen.findByText("Invalid recovery code")).toBeInTheDocument();
        await userEvent.clear(screen.getByLabelText("Recovery code"));
        await userEvent.type(screen.getByLabelText("Recovery code"), "valid-recovery");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await waitFor(() =>
            expect(document.body).not.toHaveTextContent(/Verify your session/)
        );

        dispatchVerificationRequired("recent_verification_required");
        await userEvent.click(
            screen.getByRole("button", { name: "Use authenticator app" })
        );
        expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: "Choose another method" })
        );
        await userEvent.click(screen.getByRole("button", { name: "Use security key" }));
        await waitFor(() =>
            expect(document.body).not.toHaveTextContent(/Verify your session/)
        );

        dispatchVerificationRequired("step_up_required");
        await userEvent.click(
            screen.getByRole("button", { name: "Use authenticator app" })
        );
        await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await waitFor(() =>
            expect(document.body).not.toHaveTextContent(/Verify your session/)
        );
        expect(
            calls.some(
                (call) =>
                    call.url.endsWith("/step-up/webauthn/verify") &&
                    call.method === "POST"
            )
        ).toBe(true);
        expect(
            calls.some(
                (call) =>
                    call.url.endsWith("/step-up/totp") &&
                    call.method === "POST" &&
                    (call.body as { code?: string }).code === "123456"
            )
        ).toBe(true);
        act(() => {
            queryClient.clear();
        });
    });
});
