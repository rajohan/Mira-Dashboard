import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, jest } from "bun:test";

import { GlobalSecurityVerification } from "../components/features/settings/GlobalSecurityVerification";
import type { AccountSecuritySummary } from "../hooks/useAccountSecurity";
import {
    dispatchSecurityVerificationRequired,
    type SecurityVerificationCode,
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
        mfa: false,
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
        expect(
            await screen.findByText("Verification complete. Retry the privileged action.")
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Done" }));

        dispatchVerificationRequired("recent_verification_required");
        await userEvent.click(
            screen.getByRole("button", { name: "Use authenticator app" })
        );
        expect(screen.getByLabelText("6-digit code")).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", { name: "Choose another method" })
        );
        await userEvent.click(screen.getByRole("button", { name: "Use security key" }));
        expect(
            await screen.findByText("Verification complete. Retry the privileged action.")
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Done" }));

        dispatchVerificationRequired("step_up_required");
        await userEvent.click(
            screen.getByRole("button", { name: "Use authenticator app" })
        );
        await userEvent.type(screen.getByLabelText("6-digit code"), "123456");
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        expect(
            await screen.findByText("Verification complete. Retry the privileged action.")
        ).toBeInTheDocument();
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
