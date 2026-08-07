import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import { act } from "react";

import type {
    AccountSecuritySummary,
    WebAuthnCredentialSummary,
} from "../../contracts/accountSecurity.ts";
import type { AuthSessionSummary, AuthStatus } from "../../contracts/auth.ts";
import type {
    AutomationCredentialSummary,
    AutomationPrincipalSummary,
} from "../../contracts/automationSecurity.ts";
import type { SecurityAuditEventSummary } from "../../contracts/securityAudit.ts";
import type {
    WebAuthnAuthenticationOptions,
    WebAuthnAuthenticationResponse,
    WebAuthnRegistrationOptions,
    WebAuthnRegistrationResponse,
} from "../../contracts/webauthn.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "./webauthn/webauthnClient.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = Date.now();
const user = Object.freeze({
    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
    username: "operator",
});
const currentSession: AuthSessionSummary = Object.freeze({
    authenticatedAtMs: timestampMs,
    authMethod: "password",
    createdAtMs: timestampMs,
    expiresAtMs: timestampMs + 86_400_000,
    id: "a".repeat(32),
    isCurrent: true,
    lastSeenAtMs: timestampMs,
    userAgent: "Current browser",
});
const otherSession: AuthSessionSummary = Object.freeze({
    ...currentSession,
    authenticatedAtMs: timestampMs - 10_000,
    createdAtMs: timestampMs - 10_000,
    id: "b".repeat(32),
    isCurrent: false,
    lastSeenAtMs: timestampMs - 5000,
    userAgent: "Other browser",
});
const authenticatedStatus: AuthStatus = Object.freeze({
    session: currentSession,
    state: "authenticated",
    user,
});
const recentVerification = Object.freeze({
    expiresAtMs: timestampMs + 300_000,
    recent: true as const,
    remainingMs: 300_000,
    verifiedAtMs: timestampMs,
});
const staleVerification = Object.freeze({ recent: false as const });
const disabledSummary = Object.freeze({
    checkedAtMs: timestampMs,
    mfa: {
        enabled: false,
        methods: [],
        recoveryCodesRemaining: 0,
        totpFactors: [],
        webAuthnCredentials: [],
    },
    recentAuth: { mfa: staleVerification, password: recentVerification },
    webAuthn: { available: true, rpId: "localhost" },
} satisfies AccountSecuritySummary);
const totpFactor = Object.freeze({
    confirmedAtMs: timestampMs,
    createdAtMs: timestampMs - 1000,
    id: "019fd976-9d52-7a1b-86f4-3fc41d89dedd",
    label: "Primary authenticator",
});
const enabledSummary = Object.freeze({
    checkedAtMs: timestampMs,
    mfa: {
        enabled: true,
        enabledAtMs: timestampMs,
        methods: ["recovery", "totp"],
        recoveryCodesRemaining: 10,
        totpFactors: [totpFactor],
        webAuthnCredentials: [],
    },
    recentAuth: { mfa: recentVerification, password: recentVerification },
    webAuthn: { available: true, rpId: "localhost" },
} satisfies AccountSecuritySummary);
const automationCredential = Object.freeze({
    createdAtMs: timestampMs,
    id: "019fd979-42cc-7ce4-8392-3de63748a594",
    label: "Heartbeat credential",
    prefix: "c".repeat(32),
} satisfies AutomationCredentialSummary);
const automationPrincipal = Object.freeze({
    activeCredentialCount: 1,
    authorizationVersion: 1,
    capabilities: ["notifications:read"],
    createdAtMs: timestampMs,
    disabled: false,
    id: "openclaw-heartbeat",
    label: "OpenClaw heartbeat",
    totalCredentialCount: 1,
    updatedAtMs: timestampMs,
} satisfies AutomationPrincipalSummary);
const authenticationOptions = Object.freeze({
    allowCredentials: [{ id: "AAAAAAAA", type: "public-key" }],
    challenge: "A".repeat(32),
    rpId: "localhost",
    timeout: 60_000,
    userVerification: "required",
} satisfies WebAuthnAuthenticationOptions);
const authenticationResponse = Object.freeze({
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: {},
    id: "AAAAAAAA",
    rawId: "AAAAAAAA",
    response: {
        authenticatorData: "AAAA",
        clientDataJSON: "AAAA",
        signature: "AAAA",
    },
    type: "public-key",
} satisfies WebAuthnAuthenticationResponse);
const registrationOptions = Object.freeze({
    attestation: "none",
    authenticatorSelection: {
        authenticatorAttachment: "cross-platform",
        requireResidentKey: false,
        residentKey: "discouraged",
        userVerification: "required",
    },
    challenge: "A".repeat(32),
    excludeCredentials: [],
    extensions: { credProps: true },
    hints: ["security-key"],
    pubKeyCredParams: [{ alg: -7, type: "public-key" }],
    rp: { id: "localhost", name: "Mira Dashboard" },
    timeout: 60_000,
    user: {
        displayName: "Operator",
        id: "A".repeat(16),
        name: "operator",
    },
} satisfies WebAuthnRegistrationOptions);
const registrationResponse = Object.freeze({
    authenticatorAttachment: "cross-platform",
    clientExtensionResults: { credProps: { rk: false } },
    id: "BBBBBBBB",
    rawId: "BBBBBBBB",
    response: {
        attestationObject: "AAAA",
        authenticatorData: "AAAA",
        clientDataJSON: "AAAA",
        publicKey: "AAAA",
        publicKeyAlgorithm: -7,
        transports: ["usb"],
    },
    type: "public-key",
} satisfies WebAuthnRegistrationResponse);
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
}

class SecurityTransport implements DashboardTrpcTransport {
    auditEvents: SecurityAuditEventSummary[] = [];
    authStatus: AuthStatus = authenticatedStatus;
    readonly calls: TransportCall[] = [];
    credentials = new Map<string, AutomationCredentialSummary[]>();
    mutationHandler: (path: string, input: unknown) => Promise<unknown> = (path) =>
        Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    principals: AutomationPrincipalSummary[] = [];
    sessions: AuthSessionSummary[] = [currentSession, otherSession];
    summary: AccountSecuritySummary;

    constructor(summary: AccountSecuritySummary = enabledSummary) {
        this.summary = summary;
    }

    mutation(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path });
        return this.mutationHandler(path, input);
    }

    query(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "query", path });
        switch (path) {
            case "accountSecurity.summary": {
                return Promise.resolve(this.summary);
            }
            case "auth.sessions": {
                return Promise.resolve({ sessions: this.sessions });
            }
            case "auth.status": {
                return Promise.resolve(this.authStatus);
            }
            case "automationSecurity.listCredentials": {
                if (
                    typeof input !== "object" ||
                    input === null ||
                    !("principalId" in input) ||
                    typeof input.principalId !== "string"
                ) {
                    return Promise.reject(new TypeError("Missing principal"));
                }
                const { principalId } = input;
                const credentials = this.credentials.get(principalId) ?? [];
                return Promise.resolve({
                    credentials,
                    principalId,
                    totalCredentialCount: credentials.length,
                });
            }
            case "automationSecurity.listPrincipals": {
                return Promise.resolve({
                    activePrincipalCount: this.principals.filter(
                        (principal) => !principal.disabled
                    ).length,
                    principals: this.principals,
                    totalPrincipalCount: this.principals.length,
                });
            }
            case "securityAudit.listEvents": {
                return Promise.resolve({ events: this.auditEvents });
            }
            default: {
                return Promise.reject(new TypeError(`Unexpected query: ${path}`));
            }
        }
    }
}

const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];

function renderAccountSecurity(
    transport: SecurityTransport,
    webAuthnClient: DashboardWebAuthnClient = unexpectedWebAuthnClient
) {
    const queryClient = createDashboardQueryClient();
    queryClients.push(queryClient);
    const router = createDashboardRouter(
        createMemoryHistory({ initialEntries: ["/account-security"] })
    );
    render(
        <DashboardBrowserApplication
            queryClient={queryClient}
            router={router}
            trpcClient={createDashboardTrpcClient(transport)}
            webAuthnClient={webAuthnClient}
        />
    );
    return queryClient;
}

function cachedData(queryClient: ReturnType<typeof createDashboardQueryClient>) {
    return JSON.stringify(
        queryClient
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data)
    );
}

function recoveryCodes(): string[] {
    return Array.from(
        { length: 10 },
        (_, index) =>
            `${index.toString(16).padStart(32, "0")}-${(index + 16).toString(16).padStart(32, "0")}`
    );
}

async function waitForDialogExit(): Promise<void> {
    await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 250));
    });
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
}

afterEach(() => {
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard account security route", () => {
    test("renders protected security inventories and redacted audit history", async () => {
        const transport = new SecurityTransport();
        transport.auditEvents = [
            {
                action: "auth.login",
                actor: {
                    authenticatorId: currentSession.id,
                    id: user.id,
                    kind: "user",
                },
                id: "019fd977-c837-747d-9693-bcb8e34f6d6c",
                metadata: { method: "password" },
                occurredAtMs: timestampMs,
                outcome: "succeeded",
                target: { id: user.id, type: "user" },
            },
        ];
        renderAccountSecurity(transport);

        await screen.findByRole("heading", { level: 1, name: "Account security" });
        for (const name of [
            "Verification and password",
            "Multi-factor authentication",
            "Browser sessions",
            "Automation credentials",
            "Security audit",
        ]) {
            expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
        }
        expect(await screen.findByText("auth.login")).toBeTruthy();
        expect(screen.getByText("succeeded")).toBeTruthy();
        expect(screen.getByText(/method=password/u)).toBeTruthy();
    });

    test("refreshes password and MFA proofs and changes the password ephemerally", async () => {
        const transport = new SecurityTransport();
        const webAuthnInputs: WebAuthnAuthenticationOptions[] = [];
        const webAuthnClient: DashboardWebAuthnClient = Object.freeze({
            authenticate: (options: WebAuthnAuthenticationOptions) => {
                webAuthnInputs.push(options);
                return Promise.resolve(authenticationResponse);
            },
            register: () => Promise.reject(new TypeError("Unexpected registration")),
        });
        transport.summary = {
            ...enabledSummary,
            mfa: {
                ...enabledSummary.mfa,
                methods: ["recovery", "totp", "webauthn"],
                webAuthnCredentials: [
                    {
                        backedUp: false,
                        createdAtMs: timestampMs,
                        deviceType: "singleDevice",
                        id: "019fd978-1e89-7819-b845-0c843bec6937",
                        label: "Security key",
                        transports: ["usb"],
                        usable: true,
                    },
                ],
            },
        };
        const paths: string[] = [];
        transport.mutationHandler = (path, input) => {
            paths.push(path);
            switch (path) {
                case "accountSecurity.reauthenticatePassword": {
                    expect(input).toEqual({ password: "password proof" });
                    return Promise.resolve({
                        session: currentSession,
                        verifiedAtMs: timestampMs,
                    });
                }
                case "accountSecurity.stepUpTotp": {
                    expect(input).toEqual({ code: "123456" });
                    return Promise.resolve({
                        method: "totp",
                        session: { ...currentSession, authMethod: "totp" },
                        verifiedAtMs: timestampMs,
                    });
                }
                case "accountSecurity.stepUpRecovery": {
                    expect(input).toEqual({ code: recoveryCodes()[0] });
                    return Promise.resolve({
                        method: "recovery",
                        recoveryCodesRemaining: 9,
                        session: { ...currentSession, authMethod: "recovery" },
                        verifiedAtMs: timestampMs,
                    });
                }
                case "accountSecurity.beginWebAuthnStepUp": {
                    return Promise.resolve({
                        expiresAtMs: timestampMs + 60_000,
                        options: authenticationOptions,
                    });
                }
                case "accountSecurity.stepUpWebAuthn": {
                    expect(input).toEqual({ response: authenticationResponse });
                    return Promise.resolve({
                        method: "webauthn",
                        session: { ...currentSession, authMethod: "webauthn" },
                        verifiedAtMs: timestampMs,
                    });
                }
                case "auth.changePassword": {
                    expect(input).toEqual({
                        currentPassword: "current password",
                        newPassword: "new strong password",
                    });
                    return Promise.resolve({
                        revokedSessions: 1,
                        session: currentSession,
                    });
                }
                default: {
                    return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
                }
            }
        };
        const queryClient = renderAccountSecurity(transport, webAuthnClient);
        const userActions = userEvent.setup();
        await screen.findByRole("heading", { level: 1, name: "Account security" });

        await userActions.type(screen.getByLabelText("Password proof"), "password proof");
        await userActions.click(screen.getByRole("button", { name: "Verify password" }));
        await screen.findByText("Recent password verification refreshed.");

        await userActions.type(screen.getByLabelText("Authenticator proof"), "123456");
        await userActions.click(
            screen.getByRole("button", { name: "Verify authenticator" })
        );
        await screen.findByText("Recent MFA verification refreshed.");

        await userActions.type(
            screen.getByLabelText("Recovery proof"),
            recoveryCodes()[0]!
        );
        await userActions.click(
            screen.getByRole("button", { name: "Use recovery code" })
        );
        await screen.findByText("Recovery proof accepted and recent MFA refreshed.");

        await userActions.click(
            screen.getByRole("button", { name: "Verify security key" })
        );
        await screen.findByText("Security-key verification refreshed recent MFA.");

        await userActions.type(
            screen.getByLabelText("Current password"),
            "current password"
        );
        await userActions.type(
            screen.getByLabelText("New password"),
            "new strong password"
        );
        await userActions.click(screen.getByRole("button", { name: "Change password" }));
        await screen.findByText("Password changed and other sessions revoked.");

        expect(paths).toEqual([
            "accountSecurity.reauthenticatePassword",
            "accountSecurity.stepUpTotp",
            "accountSecurity.stepUpRecovery",
            "accountSecurity.beginWebAuthnStepUp",
            "accountSecurity.stepUpWebAuthn",
            "auth.changePassword",
        ]);
        expect(webAuthnInputs).toEqual([authenticationOptions]);
        for (const secret of [
            "password proof",
            "123456",
            recoveryCodes()[0]!,
            "current password",
            "new strong password",
        ]) {
            expect(cachedData(queryClient)).not.toContain(secret);
        }
    });

    test("enrolls TOTP and reveals recovery codes only in component state", async () => {
        const transport = new SecurityTransport(disabledSummary);
        const enrollment = {
            expiresAtMs: timestampMs + 300_000,
            factorId: totpFactor.id,
            label: "Phone authenticator",
            otpauthUri:
                "otpauth://totp/Mira:operator?secret=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            secret: "A".repeat(32),
        };
        const codes = recoveryCodes();
        transport.mutationHandler = (path, input) => {
            if (path === "accountSecurity.beginTotpEnrollment") {
                expect(input).toEqual({ label: "Phone authenticator" });
                return Promise.resolve({ enrollment });
            }
            expect(path).toBe("accountSecurity.confirmTotpEnrollment");
            expect(input).toEqual({ code: "123456", factorId: totpFactor.id });
            transport.summary = enabledSummary;
            return Promise.resolve({
                enabledNow: true,
                factor: totpFactor,
                recoveryCodes: codes,
                revokedSessions: 0,
                session: { ...currentSession, authMethod: "totp" },
            });
        };
        const queryClient = renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        await screen.findByRole("heading", { level: 1, name: "Account security" });

        await userActions.type(
            screen.getByLabelText("Authenticator label"),
            "Phone authenticator"
        );
        await userActions.click(
            screen.getByRole("button", { name: "Begin authenticator enrollment" })
        );
        expect(await screen.findByText(enrollment.secret)).toBeTruthy();
        expect(cachedData(queryClient)).not.toContain(enrollment.secret);

        await userActions.type(screen.getByLabelText("Confirmation code"), "123456");
        await userActions.click(
            screen.getByRole("button", { name: "Confirm authenticator" })
        );
        expect(
            await screen.findByRole("heading", { level: 3, name: "New recovery codes" })
        ).toBeTruthy();
        expect(screen.getByText(codes[0]!)).toBeTruthy();
        expect(cachedData(queryClient)).not.toContain(codes[0]!);
        await userActions.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.queryByText(codes[0]!)).toBeNull();
    });

    test("enrolls a WebAuthn credential through the injected browser boundary", async () => {
        const transport = new SecurityTransport(enabledSummary);
        const registrationInputs: WebAuthnRegistrationOptions[] = [];
        const webAuthnClient: DashboardWebAuthnClient = Object.freeze({
            authenticate: () =>
                Promise.reject(new TypeError("Unexpected authentication")),
            register: (options: WebAuthnRegistrationOptions) => {
                registrationInputs.push(options);
                return Promise.resolve(registrationResponse);
            },
        });
        const credential = {
            backedUp: false,
            createdAtMs: timestampMs,
            deviceType: "singleDevice" as const,
            id: "019fd978-1e89-7819-b845-0c843bec6937",
            label: "Primary security key",
            transports: ["usb" as const],
            usable: true,
        } satisfies WebAuthnCredentialSummary;
        transport.mutationHandler = (path, input) => {
            if (path === "accountSecurity.beginWebAuthnEnrollment") {
                expect(input).toEqual({});
                return Promise.resolve({
                    expiresAtMs: timestampMs + 60_000,
                    options: registrationOptions,
                });
            }
            expect(path).toBe("accountSecurity.confirmWebAuthnEnrollment");
            expect(input).toEqual({
                label: credential.label,
                response: registrationResponse,
            });
            transport.summary = {
                ...enabledSummary,
                mfa: {
                    ...enabledSummary.mfa,
                    methods: ["recovery", "totp", "webauthn"],
                    webAuthnCredentials: [credential],
                },
            };
            return Promise.resolve({ credential, enabledNow: false });
        };
        renderAccountSecurity(transport, webAuthnClient);
        const userActions = userEvent.setup();
        await screen.findByRole("heading", { level: 1, name: "Account security" });

        await userActions.type(
            screen.getByLabelText("Security-key label"),
            credential.label
        );
        await userActions.click(
            screen.getByRole("button", { name: "Enroll security key" })
        );

        expect(await screen.findByText(credential.label)).toBeTruthy();
        expect(registrationInputs).toEqual([registrationOptions]);
    });

    test("confirms destructive MFA actions before mutation", async () => {
        const securityKey = {
            backedUp: false,
            createdAtMs: timestampMs,
            deviceType: "singleDevice" as const,
            id: "019fda70-b47b-7a29-b2a7-f15d32c2bfe2",
            label: "Backup security key",
            transports: ["usb" as const],
            usable: true,
        } satisfies WebAuthnCredentialSummary;
        const mixedMfaSummary = {
            ...enabledSummary,
            mfa: {
                ...enabledSummary.mfa,
                methods: ["recovery", "totp", "webauthn"] as const,
                webAuthnCredentials: [securityKey],
            },
        } satisfies AccountSecuritySummary;
        const transport = new SecurityTransport(mixedMfaSummary);
        const codes = recoveryCodes();
        transport.mutationHandler = (path, input) => {
            switch (path) {
                case "accountSecurity.removeTotpFactor": {
                    expect(input).toEqual({ factorId: totpFactor.id });
                    transport.summary = {
                        ...mixedMfaSummary,
                        mfa: {
                            ...mixedMfaSummary.mfa,
                            methods: ["recovery", "webauthn"],
                            totpFactors: [],
                        },
                    };
                    return Promise.resolve({ factorId: totpFactor.id, removed: true });
                }
                case "accountSecurity.rotateRecoveryCodes": {
                    expect(input).toEqual({});
                    return Promise.resolve({ recoveryCodes: codes });
                }
                default: {
                    return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
                }
            }
        };
        renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        await screen.findByText(totpFactor.label);

        await userActions.click(
            screen.getByRole("button", {
                name: `Remove authenticator ${totpFactor.label}`,
            })
        );
        expect(
            transport.calls.filter(
                (call) => call.path === "accountSecurity.removeTotpFactor"
            )
        ).toHaveLength(0);
        await userActions.click(
            screen.getByRole("button", { name: "Remove authenticator" })
        );
        await waitFor(() => expect(screen.queryByText(totpFactor.label)).toBeNull());
        await waitForDialogExit();

        await userActions.click(
            screen.getByRole("button", { name: "Rotate recovery codes" })
        );
        expect(
            transport.calls.filter(
                (call) => call.path === "accountSecurity.rotateRecoveryCodes"
            )
        ).toHaveLength(0);
        await userActions.click(
            screen.getByRole("button", { name: "Rotate recovery codes" })
        );
        await waitForDialogExit();
        expect(screen.getByText(codes[0]!)).toBeTruthy();
        await userActions.click(screen.getByRole("button", { name: "Dismiss" }));
    });

    test("confirms destructive automation actions before mutation", async () => {
        const transport = new SecurityTransport();
        transport.principals = [automationPrincipal];
        transport.credentials.set(automationPrincipal.id, [automationCredential]);
        transport.mutationHandler = (path, input) => {
            if (path === "automationSecurity.revokeCredential") {
                expect(input).toEqual({
                    credentialId: automationCredential.id,
                    expectedAuthorizationVersion:
                        automationPrincipal.authorizationVersion,
                    principalId: automationPrincipal.id,
                });
                const credential = {
                    ...automationCredential,
                    revokedAtMs: timestampMs + 1000,
                };
                transport.credentials.set(automationPrincipal.id, [credential]);
                return Promise.resolve({ credential, revoked: true });
            }
            expect(path).toBe("automationSecurity.disablePrincipal");
            expect(input).toEqual({
                expectedAuthorizationVersion: automationPrincipal.authorizationVersion,
                principalId: automationPrincipal.id,
            });
            const principal = {
                ...automationPrincipal,
                activeCredentialCount: 0,
                authorizationVersion: 2,
                disabled: true as const,
                disabledAtMs: timestampMs + 2000,
                updatedAtMs: timestampMs + 2000,
            };
            transport.principals = [principal];
            return Promise.resolve({
                changed: true,
                principal,
                revokedCredentials: 0,
            });
        };
        renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        await screen.findByText(automationPrincipal.label);

        await userActions.click(
            screen.getByRole("button", { name: /Manage credentials/u })
        );
        await screen.findByText(automationCredential.label);
        await userActions.click(
            screen.getByRole("button", {
                name: `Revoke credential ${automationCredential.label}`,
            })
        );
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.revokeCredential"
            )
        ).toHaveLength(0);
        await userActions.click(
            screen.getByRole("button", { name: "Revoke credential" })
        );
        expect(await screen.findByText(/revoked /u)).toBeTruthy();
        await waitForDialogExit();
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.revokeCredential"
            )
        ).toHaveLength(1);

        await userActions.click(
            screen.getByRole("button", {
                name: `Disable principal ${automationPrincipal.label}`,
            })
        );
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.disablePrincipal"
            )
        ).toHaveLength(0);
        await userActions.click(
            screen.getByRole("button", { name: "Disable principal" })
        );
        await waitFor(() =>
            expect(
                transport.calls.filter(
                    (call) => call.path === "automationSecurity.disablePrincipal"
                )
            ).toHaveLength(1)
        );
        await waitForDialogExit();
        expect(await screen.findByText(/^Disabled ·/u)).toBeTruthy();
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.disablePrincipal"
            )
        ).toHaveLength(1);
    });

    test("marks expired automation credentials unusable", async () => {
        const transport = new SecurityTransport();
        const expiredCredential = Object.freeze({
            ...automationCredential,
            createdAtMs: timestampMs - 10_000,
            expiresAtMs: timestampMs - 1,
        });
        transport.principals = [
            Object.freeze({
                ...automationPrincipal,
                activeCredentialCount: 0,
            }),
        ];
        transport.credentials.set(automationPrincipal.id, [expiredCredential]);
        renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        await screen.findByText(automationPrincipal.label);

        await userActions.click(
            screen.getByRole("button", { name: /Manage credentials/u })
        );

        const credentialLabel = await screen.findByText(expiredCredential.label);
        const credentialItem = credentialLabel.closest("li");
        expect(credentialItem?.textContent).toContain("expired ");
        expect(
            screen.queryByRole("button", {
                name: `Stage replacement for ${expiredCredential.label}`,
            })
        ).toBeNull();
        expect(
            screen.queryByRole("button", {
                name: `Revoke credential ${expiredCredential.label}`,
            })
        ).toBeNull();
    });

    test("revokes one, other, and all browser sessions with final cache teardown", async () => {
        const transport = new SecurityTransport();
        transport.mutationHandler = (path, input) => {
            if (path === "auth.revokeSession") {
                expect(input).toEqual({ sessionId: otherSession.id });
                transport.sessions = [currentSession];
                return Promise.resolve({ revoked: true });
            }
            if (path === "auth.revokeOtherSessions") {
                transport.sessions = [currentSession];
                return Promise.resolve({ revokedSessions: 0 });
            }
            expect(path).toBe("auth.revokeAllSessions");
            transport.sessions = [];
            transport.authStatus = { state: "anonymous" };
            return Promise.resolve({ revokedSessions: 1 });
        };
        const queryClient = renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        await screen.findByText("Other browser");

        await userActions.click(
            screen.getByRole("button", { name: "Revoke session Other browser" })
        );
        expect(
            screen.getByRole("dialog", { name: "Revoke browser session?" })
        ).toBeTruthy();
        expect(
            transport.calls.filter((call) => call.path === "auth.revokeSession")
        ).toHaveLength(0);
        await userActions.click(screen.getByRole("button", { name: "Revoke session" }));
        await waitFor(() => expect(screen.queryByText("Other browser")).toBeNull());
        await userActions.click(
            screen.getByRole("button", { name: "Revoke other sessions" })
        );
        await userActions.click(
            screen.getByRole("button", { name: "Revoke other sessions" })
        );
        await waitFor(() =>
            expect(
                transport.calls.filter((call) => call.path === "auth.revokeOtherSessions")
            ).toHaveLength(1)
        );
        await userActions.click(
            screen.getByRole("button", { name: "Revoke every session" })
        );
        await userActions.click(
            screen.getByRole("button", { name: "Revoke every session" })
        );

        await screen.findByRole("heading", { level: 1, name: "Sign in" });
        expect(queryClient.getQueryCache().getAll()).toHaveLength(1);
        expect(
            transport.calls
                .filter((call) => call.kind === "mutation")
                .map((call) => call.path)
        ).toEqual([
            "auth.revokeSession",
            "auth.revokeOtherSessions",
            "auth.revokeAllSessions",
        ]);
    });

    test("reveals a created automation token once without placing it in query data", async () => {
        const transport = new SecurityTransport();
        const token = `${automationCredential.prefix}.${"d".repeat(64)}`;
        transport.mutationHandler = (path, input) => {
            expect(path).toBe("automationSecurity.createPrincipal");
            expect(input).toEqual({
                capabilities: ["notifications:read"],
                id: automationPrincipal.id,
                initialCredential: { label: automationCredential.label },
                label: automationPrincipal.label,
            });
            transport.principals = [automationPrincipal];
            transport.credentials.set(automationPrincipal.id, [automationCredential]);
            return Promise.resolve({
                credential: automationCredential,
                principal: automationPrincipal,
                token,
            });
        };
        const queryClient = renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        await screen.findByRole("heading", { level: 1, name: "Account security" });

        await userActions.type(
            screen.getByLabelText("Principal ID"),
            automationPrincipal.id
        );
        await userActions.type(
            screen.getByLabelText("Principal label"),
            automationPrincipal.label
        );
        await userActions.type(
            screen.getByLabelText("Initial credential label"),
            automationCredential.label
        );
        await userActions.click(screen.getByLabelText("notifications:read"));
        await userActions.click(
            screen.getByRole("button", { name: "Create principal and credential" })
        );

        expect(await screen.findByText(token)).toBeTruthy();
        expect(cachedData(queryClient)).not.toContain(token);
        await userActions.click(screen.getByRole("button", { name: "Dismiss" }));
        expect(screen.queryByText(token)).toBeNull();
        expect(await screen.findByText(automationPrincipal.label)).toBeTruthy();
    });
});
