import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";

import { AccountSecuritySection } from "../components/features/settings/AccountSecuritySection";

const originalFetch = fetch;

afterEach(() => {
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: originalFetch,
        writable: true,
    });
});

function renderAccountSecurity() {
    const queryClient = new QueryClient({
        defaultOptions: {
            mutations: { retry: false },
            queries: { retry: false },
        },
    });
    const view = render(
        createElement(
            QueryClientProvider,
            { client: queryClient },
            createElement(AccountSecuritySection)
        )
    );
    return { ...view, queryClient };
}

describe("Dashboard account security", () => {
    it("shows named backup-key guidance and confirms factor removal", async () => {
        const fetchMock = jest.fn(
            async (input: RequestInfo | URL, init?: RequestInit) => {
                const url = String(input);
                if (url === "/api/account/security" && !init?.method) {
                    return Response.json({
                        factors: {
                            enabledAt: "2026-07-24T12:00:00.000Z",
                            methods: ["webauthn", "totp", "recovery"],
                            recoveryCodesRemaining: 9,
                            totpFactors: [
                                {
                                    confirmedAt: "2026-07-24T12:00:00.000Z",
                                    createdAt: "2026-07-24T11:59:00.000Z",
                                    id: "01900000-0000-7000-8000-000000000001",
                                    label: "Authenticator app",
                                },
                            ],
                            webAuthnCredentials: [
                                {
                                    backedUp: false,
                                    createdAt: "2026-07-24T12:00:00.000Z",
                                    deviceType: "singleDevice",
                                    id: "credential-primary",
                                    label: "Primary YubiKey",
                                },
                            ],
                        },
                        recentVerification: {
                            mfa: true,
                            password: false,
                        },
                        recommendation: {
                            minimumSecurityKeys: 2,
                            needsBackupSecurityKey: true,
                        },
                        sessions: [
                            {
                                authMethod: "webauthn",
                                authenticatedAt: "2026-07-24T12:00:00.000Z",
                                createdAt: "2026-07-24T12:00:00.000Z",
                                expiresAt: "2026-08-23T12:00:00.000Z",
                                isCurrent: true,
                                lastSeenAt: "2026-07-24T12:00:00.000Z",
                                sessionId: "0123456789abcdef0123456789abcdef",
                                userAgent: "Test browser",
                            },
                        ],
                        totp: { available: true },
                        webAuthn: {
                            available: true,
                            rpId: "dashboard.example",
                        },
                    });
                }
                throw new Error(
                    `Unexpected account-security request: ${init?.method ?? "GET"} ${url}`
                );
            }
        );
        Object.defineProperty(globalThis, "fetch", {
            configurable: true,
            value: fetchMock,
            writable: true,
        });

        const { queryClient } = renderAccountSecurity();
        expect(await screen.findByText("Primary YubiKey")).toBeInTheDocument();
        expect(screen.getByText(/Register two named YubiKeys/u)).toBeInTheDocument();
        expect(screen.getByText(/Add a second YubiKey/u)).toBeInTheDocument();
        expect(screen.getByText(/9 unused one-time codes remain/u)).toBeInTheDocument();

        await userEvent.click(
            screen.getByRole("button", {
                name: "Remove Primary YubiKey",
            })
        );
        expect(
            screen.getByRole("heading", { name: "Remove login factor" })
        ).toBeInTheDocument();
        expect(
            screen.getByText(/cannot remove the final configured second factor/u)
        ).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
        expect(
            screen.queryByRole("heading", { name: "Remove login factor" })
        ).not.toBeInTheDocument();

        await userEvent.click(screen.getByRole("button", { name: "Change password" }));
        expect(
            screen.getByRole("heading", {
                name: "Change Dashboard password",
            })
        ).toBeInTheDocument();
        queryClient.clear();
    });
});
