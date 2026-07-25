import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { GlobalSecurityVerification } from "../components/features/settings/GlobalSecurityVerification";
import {
    accountSecurityKeys,
    type AccountSecuritySummary,
} from "../hooks/useAccountSecurity";
import {
    cancelSecurityVerification,
    dispatchSecurityVerificationRequired,
    type SecurityVerificationCode,
    waitForSecurityVerification,
} from "../lib/securityVerification";
import { authActions } from "../stores/authStore";
import { createWebAuthnBrowserTestHarness } from "./webAuthnBrowserTestHelper";

const originalFetch = fetch;
const webAuthnBrowser = createWebAuthnBrowserTestHarness();

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
        mfaUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
        password: false,
    },
    recommendation: {
        minimumSecurityKeys: 2,
        needsBackupSecurityKey: true,
    },
    sessions: [],
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
        },
        user: { id: 1, username: "raymond" },
    });
});

afterEach(() => {
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
    it("opens proactively without resetting an in-progress verification", async () => {
        const expiringSummary: AccountSecuritySummary = {
            ...securitySummary,
            recentVerification: {
                ...securitySummary.recentVerification,
                mfaUntil: new Date(Date.now() - 1000).toISOString(),
            },
        };
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (String(input) === "/api/account/security") {
                    return Response.json(expiringSummary);
                }
                throw new Error(`Unexpected proactive request: ${String(input)}`);
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
        act(() => {
            queryClient.setQueryData(accountSecurityKeys.user(1), {
                ...expiringSummary,
                factors: {
                    ...expiringSummary.factors,
                    recoveryCodesRemaining: 7,
                },
                recentVerification: {
                    ...expiringSummary.recentVerification,
                },
            });
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
        let securityRequests = 0;
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (String(input) === "/api/account/security") {
                    securityRequests += 1;
                    return securityRequests === 1
                        ? Response.json(expiredSummary)
                        : secondSecurityResponse.promise;
                }
                throw new Error(`Unexpected user-switch request: ${String(input)}`);
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
            expect(document.body.textContent).not.toContain("Verify your session");
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
                },
                user: { id: 2, username: "second-user" },
            });
        });

        await waitFor(() => {
            expect(securityRequests).toBe(2);
        });
        await act(async () => {
            secondSecurityResponse.resolve(Response.json(securitySummary));
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

    it("directs enrollment-required actions to Dashboard security settings", async () => {
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (String(input) === "/api/account/security") {
                    return Response.json(securitySummary);
                }
                throw new Error(`Unexpected enrollment request: ${String(input)}`);
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
            value: jest.fn(async (input: RequestInfo | URL) => {
                if (String(input) === "/api/account/security") {
                    return Response.json(securitySummary);
                }
                throw new Error(`Unexpected cancellation request: ${String(input)}`);
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
            expect(document.body.textContent).not.toContain("Verify your session");
        });
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
                    const url = String(input);
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
            recoveryResponse.resolve(Response.json({ isOk: true }));
            await verificationPromise;
        });
        expect(await verificationPromise).toBe(true);
        await waitFor(() => {
            expect(document.body.textContent).not.toContain("Verify your session");
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
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    const url = String(input);
                    const method = init?.method ?? "GET";
                    const body =
                        typeof init?.body === "string"
                            ? JSON.parse(init.body)
                            : undefined;
                    passwordCalls.push({ body, method, url });

                    if (url === "/api/account/security" && method === "GET") {
                        return Response.json(passwordOnlySecuritySummary);
                    }
                    if (
                        url === "/api/account/security/reauth/password" &&
                        method === "POST"
                    ) {
                        return Response.json({ isOk: true });
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
                            },
                            user: { id: 1, username: "raymond" },
                        });
                    }
                    throw new Error(
                        `Unexpected password verification request: ${method} ${url}`
                    );
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

    it("handles recovery, TOTP, and security-key step-up ceremonies", async () => {
        webAuthnBrowser.install();
        const calls: Array<{ body: unknown; method: string; url: string }> = [];
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: jest.fn(
                async (
                    input: RequestInfo | URL,
                    init?: RequestInit
                ): Promise<Response> => {
                    const url = String(input);
                    const method = init?.method ?? "GET";
                    const body =
                        typeof init?.body === "string"
                            ? JSON.parse(init.body)
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
                            },
                            user: { id: 1, username: "raymond" },
                        });
                    }
                    if (
                        url === "/api/account/security/step-up/recovery" &&
                        method === "POST"
                    ) {
                        return (body as { code?: string }).code === "valid-recovery"
                            ? Response.json({ isOk: true })
                            : Response.json(
                                  { error: "Invalid recovery code" },
                                  { status: 400 }
                              );
                    }
                    if (
                        url === "/api/account/security/step-up/totp" &&
                        method === "POST"
                    ) {
                        return Response.json({ isOk: true });
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
                        return Response.json({ isOk: true });
                    }
                    throw new Error(
                        `Unexpected global verification request: ${method} ${url}`
                    );
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
            expect(document.body.textContent).not.toContain("Verify your session")
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
            expect(document.body.textContent).not.toContain("Verify your session")
        );

        dispatchVerificationRequired("step_up_required");
        await userEvent.click(
            screen.getByRole("button", { name: "Use authenticator app" })
        );
        await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await waitFor(() =>
            expect(document.body.textContent).not.toContain("Verify your session")
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
