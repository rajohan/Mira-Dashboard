import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, jest } from "bun:test";
import { createElement } from "react";

import { AccountSecuritySection } from "../components/features/settings/AccountSecuritySection";
import type { AccountSecuritySummary } from "../hooks/useAccountSecurity";
import { authActions } from "../stores/authStore";
import { createWebAuthnBrowserTestHarness } from "./webAuthnBrowserTestHelper";

const originalFetch = fetch;
const originalClipboardDescriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "clipboard"
);
const originalCreateObjectUrl = URL.createObjectURL;
const originalRevokeObjectUrl = URL.revokeObjectURL;
const webAuthnBrowser = createWebAuthnBrowserTestHarness();

afterEach(() => {
    authActions.clearSession();
    Object.defineProperties(globalThis, {
        fetch: {
            configurable: true,
            value: originalFetch,
            writable: true,
        },
    });
    webAuthnBrowser.restore();
    if (originalClipboardDescriptor) {
        Object.defineProperty(navigator, "clipboard", originalClipboardDescriptor);
    } else {
        Reflect.deleteProperty(navigator, "clipboard");
    }
    Object.defineProperties(URL, {
        createObjectURL: {
            configurable: true,
            value: originalCreateObjectUrl,
            writable: true,
        },
        revokeObjectURL: {
            configurable: true,
            value: originalRevokeObjectUrl,
            writable: true,
        },
    });
});

function summary({
    enabled = true,
    methods = ["webauthn", "totp", "recovery"],
    recentMfa = true,
    recentPassword = false,
}: {
    enabled?: boolean;
    methods?: AccountSecuritySummary["factors"]["methods"];
    recentMfa?: boolean;
    recentPassword?: boolean;
} = {}): AccountSecuritySummary {
    return {
        factors: {
            ...(enabled && { enabledAt: "2026-07-24T12:00:00.000Z" }),
            methods,
            recoveryCodesRemaining: enabled ? 9 : 0,
            totpFactors: enabled
                ? [
                      {
                          confirmedAt: "2026-07-24T12:00:00.000Z",
                          createdAt: "2026-07-24T11:59:00.000Z",
                          id: "01900000-0000-7000-8000-000000000001",
                          label: "Authenticator app",
                      },
                  ]
                : [],
            webAuthnCredentials: enabled
                ? [
                      {
                          backedUp: false,
                          createdAt: "2026-07-24T12:00:00.000Z",
                          deviceType: "singleDevice",
                          id: "credential-primary",
                          label: "Primary YubiKey",
                          lastUsedAt: "2026-07-24T12:30:00.000Z",
                      },
                  ]
                : [],
        },
        recentVerification: {
            mfa: recentMfa,
            password: recentPassword,
        },
        recommendation: {
            minimumSecurityKeys: 2,
            needsBackupSecurityKey: enabled,
        },
        sessions: [
            {
                authMethod: enabled ? "webauthn" : "password",
                authenticatedAt: "2026-07-24T12:00:00.000Z",
                createdAt: "2026-07-24T12:00:00.000Z",
                expiresAt: "2026-08-23T12:00:00.000Z",
                isCurrent: true,
                lastSeenAt: "2026-07-24T12:00:00.000Z",
                sessionId: "0123456789abcdef0123456789abcdef",
                userAgent: "Current test browser",
            },
            {
                authMethod: "password",
                authenticatedAt: "2026-07-24T11:00:00.000Z",
                createdAt: "2026-07-24T11:00:00.000Z",
                expiresAt: "2026-08-23T11:00:00.000Z",
                isCurrent: false,
                lastSeenAt: "2026-07-24T11:30:00.000Z",
                sessionId: "fedcba9876543210fedcba9876543210",
                userAgent: "Other test browser",
            },
        ],
        totp: { available: true },
        webAuthn: {
            available: true,
            rpId: "dashboard.example.com",
        },
    };
}

type FetchHandler = (
    url: string,
    method: string,
    body: unknown
) => Response | Promise<Response> | undefined;

function installAccountFetch(
    securitySummary: () => AccountSecuritySummary,
    handler: FetchHandler
) {
    const calls: Array<{ body: unknown; method: string; url: string }> = [];
    const fetchMock = jest.fn(
        async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
            const url = String(input);
            const method = init?.method ?? "GET";
            const body =
                typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
            calls.push({ body, method, url });
            if (url === "/api/account/security" && method === "GET") {
                return Response.json(securitySummary());
            }
            if (url === "/api/auth/session" && method === "GET") {
                return Response.json({
                    authenticated: true,
                    isBootstrapRequired: false,
                    session: {
                        authMethod: "webauthn",
                        expiresAt: "2026-08-23T12:00:00.000Z",
                        lastSeenAt: "2026-07-24T12:00:00.000Z",
                        mfaEnabled: Boolean(securitySummary().factors.enabledAt),
                    },
                    user: { id: 1, username: "raymond" },
                });
            }
            const handled = await handler(url, method, body);
            if (handled) {
                return handled;
            }
            throw new Error(`Unexpected account-security request: ${method} ${url}`);
        }
    );
    Object.defineProperty(globalThis, "fetch", {
        configurable: true,
        value: fetchMock,
        writable: true,
    });
    return { calls, fetchMock };
}

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

    it("reauthenticates before TOTP enrollment and exposes recovery-code actions", async () => {
        let isPasswordVerified = false;
        const recoveryCodes = ["alpha-bravo", "charlie-delta"];
        const clipboardWrite = jest.fn(async () => {});
        const createObjectUrl = jest.fn(() => "blob:recovery-codes");
        const revokeObjectUrl = jest.fn();
        Object.defineProperty(navigator, "clipboard", {
            configurable: true,
            value: { writeText: clipboardWrite },
        });
        Object.defineProperties(URL, {
            createObjectURL: {
                configurable: true,
                value: createObjectUrl,
                writable: true,
            },
            revokeObjectURL: {
                configurable: true,
                value: revokeObjectUrl,
                writable: true,
            },
        });
        const { calls } = installAccountFetch(
            () =>
                summary({
                    enabled: false,
                    methods: [],
                    recentMfa: false,
                    recentPassword: isPasswordVerified,
                }),
            (url, method, body) => {
                if (
                    url === "/api/account/security/reauth/password" &&
                    method === "POST"
                ) {
                    expect(body).toEqual({ password: "current-password" });
                    isPasswordVerified = true;
                    return Response.json({ isOk: true });
                }
                if (url === "/api/account/security/totp/setup" && method === "POST") {
                    expect(body).toEqual({ label: "Phone authenticator" });
                    return Response.json(
                        {
                            enrollment: {
                                factorId: "01900000-0000-7000-8000-000000000099",
                                label: "Phone authenticator",
                                otpauthUri:
                                    "otpauth://totp/Mira:raymond?secret=TESTSECRET",
                                secret: "TESTSECRET",
                            },
                        },
                        { status: 201 }
                    );
                }
                if (url === "/api/account/security/totp/confirm" && method === "POST") {
                    expect(body).toEqual({
                        code: "123456",
                        factorId: "01900000-0000-7000-8000-000000000099",
                    });
                    return Response.json({
                        factorId: "01900000-0000-7000-8000-000000000099",
                        isOk: true,
                        recoveryCodes,
                    });
                }
                if (
                    url === "/api/account/security/password/change" &&
                    method === "POST"
                ) {
                    expect(body).toEqual({
                        currentPassword: "current-password",
                        newPassword: "replacement-password",
                    });
                    return Response.json({ isOk: true, revokedSessions: 1 });
                }
                return;
            }
        );

        const { queryClient } = renderAccountSecurity();
        await screen.findByText("Not enabled");

        await userEvent.click(screen.getByRole("button", { name: "Add app" }));
        expect(
            screen.getByRole("heading", { name: "Verify current password" })
        ).toBeInTheDocument();
        await userEvent.type(
            screen.getByLabelText("Current password"),
            "current-password"
        );
        await userEvent.click(screen.getByRole("button", { name: "Verify" }));
        await screen.findByText("Password verified for sensitive changes");

        await userEvent.click(screen.getByRole("button", { name: "Add app" }));
        expect(
            screen.getByRole("heading", { name: "Add authenticator app" })
        ).toBeInTheDocument();
        const appName = screen.getByLabelText("App name");
        await userEvent.clear(appName);
        await userEvent.type(appName, "Phone authenticator");
        await userEvent.click(screen.getByRole("button", { name: "Create setup code" }));
        expect(await screen.findByText("Manual setup key")).toBeInTheDocument();
        expect(screen.getByText("TESTSECRET")).toBeInTheDocument();
        await userEvent.type(screen.getByLabelText("Confirm 6-digit code"), "123456");
        await userEvent.click(
            screen.getByRole("button", { name: "Confirm authenticator" })
        );

        expect(
            await screen.findByRole("heading", { name: "Save recovery codes now" })
        ).toBeInTheDocument();
        expect(screen.getByText("alpha-bravo")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Copy" }));
        await waitFor(() => {
            expect(clipboardWrite).toHaveBeenCalledWith("alpha-bravo\ncharlie-delta");
        });
        await userEvent.click(screen.getByRole("button", { name: "Download" }));
        expect(createObjectUrl).toHaveBeenCalled();
        expect(revokeObjectUrl).toHaveBeenCalledWith("blob:recovery-codes");
        await userEvent.click(
            screen.getByRole("button", {
                name: "Close Save recovery codes now",
            })
        );

        await userEvent.click(screen.getByRole("button", { name: "Change password" }));
        await userEvent.type(
            screen.getByLabelText("Current password"),
            "current-password"
        );
        await userEvent.type(
            screen.getByLabelText("New password"),
            "replacement-password"
        );
        await userEvent.type(
            screen.getByLabelText("Confirm new password"),
            "different-password"
        );
        await userEvent.click(
            screen.getByRole("button", {
                name: "Change and revoke other sessions",
            })
        );
        expect(screen.getByText("New passwords do not match")).toBeInTheDocument();
        const confirmPassword = screen.getByLabelText("Confirm new password");
        await userEvent.clear(confirmPassword);
        await userEvent.type(confirmPassword, "replacement-password");
        await userEvent.click(
            screen.getByRole("button", {
                name: "Change and revoke other sessions",
            })
        );
        expect(
            await screen.findByText("Password changed; 1 other session revoked")
        ).toBeInTheDocument();
        expect(
            calls.some(
                (call) =>
                    call.url === "/api/account/security/totp/confirm" &&
                    call.method === "POST"
            )
        ).toBe(true);
        queryClient.clear();
    });

    it("supports recovery-only step-up, factor removal, session revocation, and disable", async () => {
        let securitySummary = summary({
            methods: ["recovery"],
            recentMfa: true,
        });
        let removalAttempts = 0;
        const { calls } = installAccountFetch(
            () => securitySummary,
            (url, method, body) => {
                if (
                    url === "/api/account/security/step-up/recovery" &&
                    method === "POST"
                ) {
                    expect(body).toEqual({ code: "recovery-only-code" });
                    return Response.json({ isOk: true });
                }
                if (
                    url === "/api/account/security/webauthn/credential-primary" &&
                    method === "DELETE"
                ) {
                    removalAttempts += 1;
                    if (removalAttempts === 1) {
                        return Response.json(
                            { error: "Temporary removal failure" },
                            { status: 500 }
                        );
                    }
                    securitySummary = {
                        ...securitySummary,
                        factors: {
                            ...securitySummary.factors,
                            webAuthnCredentials: [],
                        },
                    };
                    return Response.json({ isOk: true });
                }
                if (
                    method === "DELETE" &&
                    url.startsWith("/api/account/security/totp/")
                ) {
                    securitySummary = {
                        ...securitySummary,
                        factors: {
                            ...securitySummary.factors,
                            totpFactors: [],
                        },
                    };
                    return Response.json({ isOk: true });
                }
                if (
                    url === "/api/account/security/recovery-codes/rotate" &&
                    method === "POST"
                ) {
                    return Response.json({
                        recoveryCodes: ["rotated-one", "rotated-two"],
                    });
                }
                if (
                    method === "DELETE" &&
                    url.startsWith("/api/account/security/sessions/")
                ) {
                    return Response.json({ isOk: true, loggedOut: false });
                }
                if (
                    url === "/api/account/security/sessions/revoke-others" &&
                    method === "POST"
                ) {
                    return Response.json({ isOk: true, revoked: 1 });
                }
                if (
                    url === "/api/account/security/sessions/revoke-all" &&
                    method === "POST"
                ) {
                    return Response.json({ isOk: true, revoked: 2 });
                }
                if (url === "/api/account/security/mfa/disable" && method === "POST") {
                    expect(body).toEqual({ password: "current-password" });
                    securitySummary = summary({
                        enabled: false,
                        methods: [],
                        recentMfa: false,
                    });
                    return Response.json({ isOk: true });
                }
                return;
            }
        );

        const { queryClient } = renderAccountSecurity();
        await screen.findByText("Enabled");

        await userEvent.click(screen.getByRole("button", { name: "Verify now" }));
        expect(screen.getByLabelText("Recovery code")).toBeInTheDocument();
        await userEvent.type(
            screen.getByLabelText("Recovery code"),
            "recovery-only-code"
        );
        await userEvent.click(screen.getByRole("button", { name: "Use recovery code" }));
        expect(
            await screen.findByText("Recent MFA verification recorded")
        ).toBeInTheDocument();

        await userEvent.click(
            screen.getByRole("button", { name: "Remove Primary YubiKey" })
        );
        await userEvent.click(screen.getByRole("button", { name: "Remove factor" }));
        expect(await screen.findByText("Temporary removal failure")).toBeInTheDocument();
        await userEvent.click(screen.getByRole("button", { name: "Remove factor" }));
        expect(await screen.findByText("Security key removed")).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.queryByText("Primary YubiKey")).not.toBeInTheDocument();
        });

        await userEvent.click(
            screen.getByRole("button", { name: "Remove Authenticator app" })
        );
        await userEvent.click(screen.getByRole("button", { name: "Remove factor" }));
        expect(await screen.findByText("Authenticator app removed")).toBeInTheDocument();
        await waitFor(() => {
            expect(screen.queryByText("Authenticator app")).not.toBeInTheDocument();
        });

        await userEvent.click(screen.getByRole("button", { name: "Rotate codes" }));
        expect(await screen.findByText("rotated-one")).toBeInTheDocument();
        await userEvent.click(
            screen.getByRole("button", {
                name: "Close Save recovery codes now",
            })
        );

        await userEvent.click(screen.getByRole("button", { name: "Revoke" }));
        await waitFor(() => {
            expect(
                calls.some(
                    (call) =>
                        call.url.endsWith("/sessions/fedcba9876543210fedcba9876543210") &&
                        call.method === "DELETE"
                )
            ).toBe(true);
        });
        await userEvent.click(screen.getByRole("button", { name: "Log out others" }));
        await waitFor(() => {
            expect(
                calls.some(
                    (call) =>
                        call.url.endsWith("/sessions/revoke-others") &&
                        call.method === "POST"
                )
            ).toBe(true);
        });

        await userEvent.click(screen.getByRole("button", { name: "Log out all" }));
        await waitFor(() => {
            expect(
                calls.some(
                    (call) =>
                        call.url.endsWith("/sessions/revoke-all") &&
                        call.method === "POST"
                )
            ).toBe(true);
        });

        await userEvent.click(screen.getByRole("button", { name: "Disable MFA" }));
        await userEvent.type(
            screen.getByLabelText("Current password"),
            "current-password"
        );
        await userEvent.click(
            screen.getByRole("button", { name: "Disable and revoke sessions" })
        );
        expect(await screen.findByText("Two-step login disabled")).toBeInTheDocument();
        expect(await screen.findByText("Not enabled")).toBeInTheDocument();
        queryClient.clear();
    });

    it("registers a named backup security key through the browser ceremony", async () => {
        webAuthnBrowser.install();
        const recoveryCodes = ["key-recovery-one", "key-recovery-two"];
        const { calls } = installAccountFetch(
            () => summary(),
            (url, method, body) => {
                if (
                    url === "/api/account/security/webauthn/register/options" &&
                    method === "POST"
                ) {
                    return Response.json({
                        options: {
                            attestation: "none",
                            authenticatorSelection: {
                                authenticatorAttachment: "cross-platform",
                                residentKey: "discouraged",
                                userVerification: "required",
                            },
                            challenge: "AA",
                            pubKeyCredParams: [{ alg: -7, type: "public-key" }],
                            rp: {
                                id: "dashboard.example.com",
                                name: "Mira Dashboard",
                            },
                            timeout: 60_000,
                            user: {
                                displayName: "raymond",
                                id: "AA",
                                name: "raymond",
                            },
                        },
                    });
                }
                if (
                    url === "/api/account/security/webauthn/register/verify" &&
                    method === "POST"
                ) {
                    expect(body).toMatchObject({
                        label: "Backup YubiKey",
                        response: {
                            id: "credential-browser",
                            type: "public-key",
                        },
                    });
                    return Response.json({
                        credential: {
                            backedUp: false,
                            createdAt: "2026-07-24T12:00:00.000Z",
                            deviceType: "singleDevice",
                            id: "credential-browser",
                            label: "Backup YubiKey",
                        },
                        isOk: true,
                        recoveryCodes,
                    });
                }
                return;
            }
        );

        const { queryClient } = renderAccountSecurity();
        await screen.findByText("Primary YubiKey");
        await userEvent.click(screen.getByRole("button", { name: "Add key" }));
        expect(
            screen.getByRole("heading", { name: "Register security key" })
        ).toBeInTheDocument();
        expect(screen.getByLabelText("Key name")).toHaveValue("Backup YubiKey");
        await userEvent.click(
            screen.getByRole("button", { name: "Touch and register key" })
        );
        expect(await screen.findByText("Security key registered")).toBeInTheDocument();
        expect(await screen.findByText("key-recovery-one")).toBeInTheDocument();
        expect(
            calls.some(
                (call) =>
                    call.url.endsWith("/webauthn/register/verify") &&
                    call.method === "POST"
            )
        ).toBe(true);
        queryClient.clear();
    });
});
