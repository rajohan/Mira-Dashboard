import { afterEach, describe, expect, spyOn, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";
import type { TRPCRequestOptions } from "@trpc/client";

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
import {
    authStatusCacheIdentity,
    authStatusQueryKey,
    publishAuthenticationStatus,
} from "../auth/authQueries.ts";
import {
    createDashboardBrowserCollections,
    type DashboardBrowserCollections,
} from "../data/dashboardCollections.ts";
import { createDashboardRouter } from "../router.tsx";
import { emptyNotificationListResult } from "../test/notifications.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";
import {
    automationCredentialsQueryKey,
    automationPrincipalsQueryKey,
} from "./securityQueries.ts";
import {
    createSecurityVerificationCoordinator,
    type SecurityVerificationCoordinator,
} from "./securityVerificationCoordinator.ts";
import type { DashboardWebAuthnClient } from "./webauthn/webauthnClient.ts";

const { act, fireEvent, render, screen, waitFor, within } =
    await import("@testing-library/react");
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
const rotatedSession: AuthSessionSummary = Object.freeze({
    ...currentSession,
    id: "c".repeat(32),
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
const rotatedAuthenticatedStatus: AuthStatus = Object.freeze({
    ...authenticatedStatus,
    session: rotatedSession,
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
    authStatusQueryHandler: (() => Promise<AuthStatus>) | undefined;
    readonly calls: TransportCall[] = [];
    credentials = new Map<string, AutomationCredentialSummary[]>();
    credentialListQueryHandler: ((input: unknown) => Promise<unknown>) | undefined;
    mutationHandler: (
        path: string,
        input: unknown,
        options?: TRPCRequestOptions
    ) => Promise<unknown> = (path) =>
        Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    principals: AutomationPrincipalSummary[] = [];
    principalListError: Error | undefined;
    sessions: AuthSessionSummary[] = [currentSession, otherSession];
    summary: AccountSecuritySummary;

    constructor(summary: AccountSecuritySummary = enabledSummary) {
        this.summary = summary;
    }

    mutation(
        path: string,
        input?: unknown,
        options?: TRPCRequestOptions
    ): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path });
        return this.mutationHandler(path, input, options);
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
                return (
                    this.authStatusQueryHandler?.() ?? Promise.resolve(this.authStatus)
                );
            }
            case "notifications.list": {
                return Promise.resolve(emptyNotificationListResult);
            }
            case "automationSecurity.listCredentials": {
                if (this.credentialListQueryHandler !== undefined) {
                    return this.credentialListQueryHandler(input);
                }
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
                if (this.principalListError !== undefined) {
                    return Promise.reject(this.principalListError);
                }
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
const collectionRegistries: DashboardBrowserCollections[] = [];
const mountedViews: ReturnType<typeof render>[] = [];

interface DeferredCollectionReset {
    readonly completion: Promise<void>;
    readonly gate: PromiseWithResolvers<void>;
}

function deferCollectionResets(source: DashboardBrowserCollections) {
    const resets: DeferredCollectionReset[] = [];
    const collections: DashboardBrowserCollections = Object.freeze({
        get agents() {
            return source.agents;
        },
        get notifications() {
            return source.notifications;
        },
        async cleanup(): Promise<void> {
            for (const reset of resets) reset.gate.resolve();
            await Promise.allSettled(resets.map((reset) => reset.completion));
            await source.cleanup();
        },
        reset(): Promise<void> {
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
            if (reset === undefined)
                throw new TypeError(`Reset ${index} has not started`);
            reset.gate.resolve();
            await reset.completion;
        },
        get resetCount() {
            return resets.length;
        },
    };
}

function renderAccountSecurity(
    transport: SecurityTransport,
    webAuthnClient: DashboardWebAuthnClient = unexpectedWebAuthnClient,
    transformCollections: (
        collections: DashboardBrowserCollections
    ) => DashboardBrowserCollections = (collections) => collections,
    securityVerificationEnabled = false,
    onSecurityVerification?: (coordinator: SecurityVerificationCoordinator) => void
) {
    const queryClient = createDashboardQueryClient();
    queryClients.push(queryClient);
    const router = createDashboardRouter(
        createMemoryHistory({ initialEntries: ["/account-security"] })
    );
    const securityVerification = securityVerificationEnabled
        ? createSecurityVerificationCoordinator(() => {
              const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
              return status === undefined ? undefined : authStatusCacheIdentity(status);
          })
        : undefined;
    if (securityVerification !== undefined) {
        onSecurityVerification?.(securityVerification);
    }
    const trpcClient = createDashboardTrpcClient(transport, { securityVerification });
    const collections = transformCollections(
        createDashboardBrowserCollections(queryClient, trpcClient)
    );
    collectionRegistries.push(collections);
    mountedViews.push(
        render(
            <DashboardBrowserApplication
                collections={collections}
                queryClient={queryClient}
                realtimeClient={noOpDashboardRealtimeClient}
                router={router}
                securityVerification={securityVerification}
                trpcClient={trpcClient}
                webAuthnClient={webAuthnClient}
            />
        )
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
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(screen.queryByRole("dialog", { hidden: true })).toBeNull();
}

async function submitGlobalProofAndWaitForRefresh(
    queryClient: ReturnType<typeof createDashboardQueryClient>,
    operationReplayed: Promise<void>,
    submitButtonName: "Use recovery code" | "Verify authenticator" | "Verify password"
): Promise<void> {
    const refreshCompletion = Promise.withResolvers<void>();
    let replayed = false;
    let observedRefresh = false;
    let settled = false;
    const resolveWhenSettled = () => {
        const authentication = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
        if (!replayed || settled) return;
        if (queryClient.isFetching() !== 0) {
            observedRefresh = true;
            return;
        }
        if (
            !observedRefresh ||
            authentication?.state !== "authenticated" ||
            authentication.session.id !== rotatedSession.id
        ) {
            return;
        }
        settled = true;
        refreshCompletion.resolve();
    };
    const unsubscribeQueryCache = queryClient
        .getQueryCache()
        .subscribe(resolveWhenSettled);
    const replayReadiness = operationReplayed.then(() => {
        replayed = true;
        resolveWhenSettled();
        return true;
    });
    await act(async () => {
        try {
            screen.getByRole("button", { name: submitButtonName }).click();
            await replayReadiness;
            await refreshCompletion.promise;
        } finally {
            unsubscribeQueryCache();
        }
    });
    expect(settled).toBeTrue();
}

afterEach(async () => {
    for (const view of mountedViews.splice(0)) view.unmount();
    await Promise.all(
        collectionRegistries.splice(0).map((collections) => collections.cleanup())
    );
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard account security route", () => {
    test("retries a failed principal refetch while retaining cached accounts", async () => {
        const transport = new SecurityTransport();
        transport.principals = [automationPrincipal];
        const queryClient = renderAccountSecurity(transport);

        expect(
            await screen.findByText("OpenClaw heartbeat", {}, { timeout: 4000 })
        ).toBeVisible();
        transport.principalListError = new TypeError("private principal failure");
        await act(async () => {
            await queryClient.invalidateQueries({
                queryKey: automationPrincipalsQueryKey,
            });
        });

        expect(screen.getByText("OpenClaw heartbeat")).toBeVisible();
        const automationSection = screen
            .getByRole("heading", { level: 2, name: "Automation access" })
            .closest("section")!;
        await waitFor(() =>
            expect(within(automationSection).getByRole("alert")).toBeVisible()
        );
        const callsBeforeRetry = transport.calls.filter(
            ({ path }) => path === "automationSecurity.listPrincipals"
        ).length;
        transport.principalListError = undefined;
        await userEvent
            .setup()
            .click(within(automationSection).getByRole("button", { name: "Try again" }));
        await waitFor(() =>
            expect(
                transport.calls.filter(
                    ({ path }) => path === "automationSecurity.listPrincipals"
                )
            ).toHaveLength(callsBeforeRetry + 1)
        );
    });

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
        const actEnvironment: unknown = Reflect.get(
            globalThis,
            "IS_REACT_ACT_ENVIRONMENT"
        );
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
        renderAccountSecurity(transport);

        await screen.findByRole("heading", { level: 1, name: "Account security" });
        await screen.findByText("auth.login");
        Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", actEnvironment);
        for (const name of [
            "Verification and password",
            "Multi-factor authentication",
            "Active sessions",
            "Automation access",
            "Security audit",
        ]) {
            expect(screen.getByRole("heading", { level: 2, name })).toBeTruthy();
        }
        expect(screen.getByText("auth.login")).toBeTruthy();
        expect(screen.getByText("succeeded")).toBeTruthy();
        expect(screen.getByText(/method=password/u)).toBeTruthy();
        expect(screen.queryByRole("button", { name: "Time" })).toBeNull();
    });

    test("refreshes password and MFA proofs and changes the password ephemerally", async () => {
        const transport = new SecurityTransport();
        const passwordChangeResponse = Promise.withResolvers<unknown>();
        const webAuthnInputs: WebAuthnAuthenticationOptions[] = [];
        const webAuthnClient: DashboardWebAuthnClient = Object.freeze({
            authenticate: (options: WebAuthnAuthenticationOptions) => {
                webAuthnInputs.push(options);
                return Promise.resolve(authenticationResponse);
            },
            register: () => Promise.reject(new TypeError("Unexpected registration")),
        });
        const mfaProofSummary = {
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
        } satisfies AccountSecuritySummary;
        transport.summary = {
            ...disabledSummary,
            recentAuth: { mfa: staleVerification, password: staleVerification },
        };
        const paths: string[] = [];
        let totpProofAttempts = 0;
        transport.mutationHandler = (path, input) => {
            paths.push(path);
            switch (path) {
                case "accountSecurity.reauthenticatePassword": {
                    expect(input).toEqual({ password: "password proof" });
                    transport.summary = mfaProofSummary;
                    return Promise.resolve({
                        session: currentSession,
                        verifiedAtMs: timestampMs,
                    });
                }
                case "accountSecurity.stepUpTotp": {
                    expect(input).toEqual({ code: "123456" });
                    totpProofAttempts += 1;
                    if (totpProofAttempts === 1) {
                        throw Object.assign(
                            new Error("Safe authenticator proof failure"),
                            {
                                data: { code: "UNAUTHORIZED" },
                            }
                        );
                    }
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
                    return passwordChangeResponse.promise;
                }
                default: {
                    return Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
                }
            }
        };
        let deferredCollections: ReturnType<typeof deferCollectionResets> | undefined;
        const queryClient = renderAccountSecurity(
            transport,
            webAuthnClient,
            (collections) => {
                deferredCollections = deferCollectionResets(collections);
                return deferredCollections.collections;
            }
        );
        const previousSessionPrivateQueryKey = [
            "test",
            "password-change-session-a",
        ] as const;
        const userActions = userEvent.setup();
        await waitFor(() => expect(deferredCollections?.resetCount).toBe(1));
        await act(() => deferredCollections?.release(0));
        await screen.findByRole("heading", { level: 1, name: "Account security" });
        act(() => {
            queryClient.setQueryData(
                previousSessionPrivateQueryKey,
                "private session A data"
            );
        });

        await userActions.click(screen.getByRole("button", { name: "Verify password" }));
        const passwordVerificationDialog = screen.getByRole("dialog", {
            name: "Verify current password",
        });
        fireEvent.change(
            within(passwordVerificationDialog).getByLabelText(
                "Password to confirm your identity"
            ),
            { target: { value: "password proof" } }
        );
        await userActions.click(
            within(passwordVerificationDialog).getByRole("button", {
                name: "Verify password",
            })
        );
        await screen.findByText("Password confirmed.");
        await waitForDialogExit();

        await userActions.click(screen.getByRole("button", { name: "Verify now" }));
        let mfaVerificationDialog = screen.getByRole("dialog", {
            name: "Verify second factor",
        });
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Use authenticator app",
            })
        );
        fireEvent.change(
            within(mfaVerificationDialog).getByLabelText("Authenticator code"),
            { target: { value: "123456" } }
        );
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Verify authenticator",
            })
        );
        expect(
            await within(mfaVerificationDialog).findByText(
                "The credentials or session are no longer valid."
            )
        ).toBeTruthy();
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Choose another method",
            })
        );
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Use authenticator app",
            })
        );
        fireEvent.change(
            within(mfaVerificationDialog).getByLabelText("Authenticator code"),
            { target: { value: "123456" } }
        );
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Verify authenticator",
            })
        );
        await screen.findByText("Authenticator code accepted.");
        await waitForDialogExit();

        await userActions.click(screen.getByRole("button", { name: "Verify now" }));
        mfaVerificationDialog = screen.getByRole("dialog", {
            name: "Verify second factor",
        });
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Use recovery code",
            })
        );
        fireEvent.change(within(mfaVerificationDialog).getByLabelText("Recovery code"), {
            target: { value: recoveryCodes()[0]! },
        });
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Use recovery code",
            })
        );
        await screen.findByText("Recovery code accepted.");
        await waitForDialogExit();

        await userActions.click(screen.getByRole("button", { name: "Verify now" }));
        mfaVerificationDialog = screen.getByRole("dialog", {
            name: "Verify second factor",
        });
        await userActions.click(
            within(mfaVerificationDialog).getByRole("button", {
                name: "Use a security key",
            })
        );
        await screen.findByText("Security key confirmed.");
        await waitForDialogExit();

        await userActions.click(screen.getByRole("button", { name: "Change password" }));
        const passwordChangeDialog = screen.getByRole("dialog", {
            name: "Change Dashboard password",
        });
        await userActions.type(
            within(passwordChangeDialog).getByLabelText("Current password"),
            "current password"
        );
        await userActions.type(
            within(passwordChangeDialog).getByLabelText("New password"),
            "new strong password"
        );
        await userActions.type(
            within(passwordChangeDialog).getByLabelText("Confirm new password"),
            "new strong password"
        );
        await userActions.click(
            within(passwordChangeDialog).getByRole("button", {
                name: "Change and sign out others",
            })
        );
        await waitFor(() => expect(paths.at(-1)).toBe("auth.changePassword"));
        const authenticationPublished = Promise.withResolvers<void>();
        const unsubscribeAuthentication = queryClient.getQueryCache().subscribe(() => {
            const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (
                status?.state === "authenticated" &&
                status.session.id === rotatedSession.id
            ) {
                authenticationPublished.resolve();
            }
        });
        await act(async () => {
            transport.authStatus = {
                ...authenticatedStatus,
                session: rotatedSession,
            };
            transport.sessions = [rotatedSession];
            passwordChangeResponse.resolve({
                revokedSessions: 1,
                session: rotatedSession,
            });
            await authenticationPublished.promise;
        });
        unsubscribeAuthentication();
        await waitFor(() => expect(deferredCollections?.resetCount).toBe(2));
        expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toMatchObject({
            session: { id: rotatedSession.id },
        });
        expect(screen.queryByRole("heading", { name: "Account security" })).toBeNull();
        expect(
            screen.getByRole("status", { name: "Preparing secure session data…" })
        ).toBeTruthy();
        expect(queryClient.getQueryData<string>(previousSessionPrivateQueryKey)).toBe(
            "private session A data"
        );

        await act(() => deferredCollections?.release(1));
        expect(
            await screen.findByRole("heading", { level: 1, name: "Account security" })
        ).toBeTruthy();
        expect(
            queryClient.getQueryData<string>(previousSessionPrivateQueryKey)
        ).toBeUndefined();

        expect(paths).toEqual([
            "accountSecurity.reauthenticatePassword",
            "accountSecurity.stepUpTotp",
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
    }, 15_000);

    test("does not republish a delayed password rotation after logout", async () => {
        const transport = new SecurityTransport(disabledSummary);
        const passwordChangeResponse = Promise.withResolvers<unknown>();
        let passwordChangeSignal: AbortSignal | undefined;
        transport.mutationHandler = (path, input, options) => {
            expect(path).toBe("auth.changePassword");
            expect(input).toEqual({
                currentPassword: "current password",
                newPassword: "new strong password",
            });
            passwordChangeSignal = options?.signal;
            return passwordChangeResponse.promise;
        };
        let deferredCollections: ReturnType<typeof deferCollectionResets> | undefined;
        const queryClient = renderAccountSecurity(
            transport,
            unexpectedWebAuthnClient,
            (collections) => {
                deferredCollections = deferCollectionResets(collections);
                return deferredCollections.collections;
            }
        );
        const publishedAuthenticationStatuses: AuthStatus[] = [];
        const unsubscribeAuthentication = queryClient.getQueryCache().subscribe(() => {
            const status = queryClient.getQueryData<AuthStatus>(authStatusQueryKey);
            if (status !== undefined) publishedAuthenticationStatuses.push(status);
        });
        const userActions = userEvent.setup();

        try {
            await waitFor(() => expect(deferredCollections?.resetCount).toBe(1));
            await act(() => deferredCollections?.release(0));
            await screen.findByRole("heading", {
                level: 1,
                name: "Account security",
            });

            await userActions.click(
                screen.getByRole("button", { name: "Change password" })
            );
            const passwordChangeDialog = screen.getByRole("dialog", {
                name: "Change Dashboard password",
            });
            await userActions.type(
                within(passwordChangeDialog).getByLabelText("Current password"),
                "current password"
            );
            await userActions.type(
                within(passwordChangeDialog).getByLabelText("New password"),
                "new strong password"
            );
            await userActions.type(
                within(passwordChangeDialog).getByLabelText("Confirm new password"),
                "new strong password"
            );
            await userActions.click(
                within(passwordChangeDialog).getByRole("button", {
                    name: "Change and sign out others",
                })
            );
            await waitFor(() => expect(passwordChangeSignal).toBeInstanceOf(AbortSignal));
            expect(passwordChangeSignal?.aborted).toBeFalse();

            transport.authStatus = { state: "anonymous" };
            transport.sessions = [];
            await act(() =>
                publishAuthenticationStatus(queryClient, { state: "anonymous" })
            );
            await waitFor(() => expect(deferredCollections?.resetCount).toBe(2));
            expect(passwordChangeSignal?.aborted).toBeTrue();
            expect(
                screen.queryByRole("heading", { name: "Account security" })
            ).toBeNull();
            expect(
                screen.getByRole("status", { name: "Preparing secure session data…" })
            ).toBeTruthy();
            const queryCallCountBeforeDelayedResponse = transport.calls.filter(
                (call) => call.kind === "query"
            ).length;

            await act(async () => {
                passwordChangeResponse.resolve({
                    revokedSessions: 1,
                    session: rotatedSession,
                });
                await new Promise((resolve) => setTimeout(resolve, 0));
            });

            expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual({
                state: "anonymous",
            });
            expect(
                publishedAuthenticationStatuses.some(
                    (status) =>
                        status.state === "authenticated" &&
                        status.session.id === rotatedSession.id
                )
            ).toBeFalse();
            expect(transport.calls.filter((call) => call.kind === "query")).toHaveLength(
                queryCallCountBeforeDelayedResponse
            );
            expect(
                screen.queryByText(
                    "Password changed. Your other browsers were signed out."
                )
            ).toBeNull();

            await act(() => deferredCollections?.release(1));
            expect(
                await screen.findByRole("heading", { level: 1, name: "Sign in" })
            ).toBeTruthy();
            expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual({
                state: "anonymous",
            });
        } finally {
            unsubscribeAuthentication();
        }
    });

    test("preserves first-TOTP recovery codes through the session rotation", async () => {
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
            transport.authStatus = rotatedAuthenticatedStatus;
            return Promise.resolve({
                enabledNow: true,
                factor: totpFactor,
                recoveryCodes: codes,
                revokedSessions: 0,
                session: { ...rotatedSession, authMethod: "totp" },
            });
        };
        const queryClient = renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        const addAuthenticatorButton = await screen.findByRole("button", {
            name: "Add authenticator app",
        });

        expect(screen.queryByLabelText("Name")).toBeNull();
        await userActions.click(addAuthenticatorButton);
        const authenticatorName = screen.getByLabelText("Name");
        expect(authenticatorName).toHaveFocus();
        await userActions.type(authenticatorName, "Phone authenticator");
        await act(async () => {
            screen.getByRole("button", { name: "Continue" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (screen.queryByText(enrollment.secret) !== null) break;
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(await screen.findByText(enrollment.secret)).toBeTruthy();
        expect(cachedData(queryClient)).not.toContain(enrollment.secret);

        await userActions.type(screen.getByLabelText("Confirmation code"), "123456");
        await act(async () => {
            screen.getByRole("button", { name: "Confirm authenticator" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (
                    screen.queryByRole("dialog", {
                        name: "Save recovery codes now",
                    }) !== null &&
                    queryClient.isFetching() === 0
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        const recoveryDialog = await screen.findByRole("dialog", {
            name: "Save recovery codes now",
        });
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await waitFor(() =>
            expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
                rotatedAuthenticatedStatus
            )
        );
        expect(within(recoveryDialog).getByText(codes[0]!)).toBeTruthy();
        expect(cachedData(queryClient)).not.toContain(codes[0]!);
        await userActions.click(
            within(recoveryDialog).getByRole("button", { name: "Close dialog" })
        );
        await waitForDialogExit();
        expect(screen.queryByText(codes[0]!)).toBeNull();
    });

    test("preserves first-WebAuthn recovery codes through the session rotation", async () => {
        const transport = new SecurityTransport(disabledSummary);
        const codes = recoveryCodes();
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
                    methods: ["recovery", "webauthn"],
                    totpFactors: [],
                    webAuthnCredentials: [credential],
                },
            };
            transport.authStatus = rotatedAuthenticatedStatus;
            return Promise.resolve({
                credential,
                enabledNow: true,
                recoveryCodes: codes,
                revokedSessions: 0,
                session: { ...rotatedSession, authMethod: "webauthn" },
            });
        };
        const queryClient = renderAccountSecurity(transport, webAuthnClient);
        const userActions = userEvent.setup();

        await userActions.click(
            await screen.findByRole("button", { name: "Add security key" })
        );
        await userActions.type(screen.getByLabelText("Name"), credential.label);
        await act(async () => {
            screen.getByRole("button", { name: "Continue" }).click();
            for (let attempt = 0; attempt < 50; attempt += 1) {
                if (
                    screen.queryByRole("dialog", {
                        name: "Save recovery codes now",
                    }) !== null &&
                    queryClient.isFetching() === 0
                ) {
                    break;
                }
                await new Promise((resolve) => setTimeout(resolve, 0));
            }
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        const recoveryDialog = await screen.findByRole("dialog", {
            name: "Save recovery codes now",
        });
        expect(screen.getAllByRole("dialog")).toHaveLength(1);
        await waitFor(() =>
            expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
                rotatedAuthenticatedStatus
            )
        );
        expect(registrationInputs).toEqual([registrationOptions]);
        expect(within(recoveryDialog).getByText(codes[0]!)).toBeTruthy();
        expect(cachedData(queryClient)).not.toContain(codes[0]!);
        await userActions.click(
            within(recoveryDialog).getByRole("button", { name: "Close dialog" })
        );
        await waitForDialogExit();
        expect(screen.queryByText(codes[0]!)).toBeNull();
    });

    test("holds WebAuthn enrollment through step-up and reconciles a newer generation", async () => {
        const transport = new SecurityTransport(enabledSummary);
        const registration = Promise.withResolvers<WebAuthnRegistrationResponse>();
        const registrationStarted = Promise.withResolvers<void>();
        const staleQueryReconciliation = Promise.withResolvers<AuthStatus>();
        const stalePublicationReconciliation = Promise.withResolvers<AuthStatus>();
        const currentReconciliation = Promise.withResolvers<AuthStatus>();
        const reconciliationResponses = [
            staleQueryReconciliation,
            stalePublicationReconciliation,
            currentReconciliation,
        ] as const;
        const secondReconciliationStarted = Promise.withResolvers<void>();
        const thirdReconciliationStarted = Promise.withResolvers<void>();
        const latestSession = Object.freeze({
            ...rotatedSession,
            id: "d".repeat(32),
        });
        const latestAuthenticatedStatus = Object.freeze({
            ...authenticatedStatus,
            session: latestSession,
        }) satisfies AuthStatus;
        let reconciliationRequestCount = 0;
        let securityVerification: SecurityVerificationCoordinator | undefined;
        let stepUpAttempts = 0;
        const registrationInputs: WebAuthnRegistrationOptions[] = [];
        const webAuthnClient: DashboardWebAuthnClient = Object.freeze({
            authenticate: () =>
                Promise.reject(new TypeError("Unexpected authentication")),
            register: (options: WebAuthnRegistrationOptions) => {
                registrationInputs.push(options);
                registrationStarted.resolve();
                return registration.promise;
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
        let beginAttempts = 0;
        transport.mutationHandler = (path, input) => {
            if (path === "accountSecurity.stepUpTotp") {
                expect(input).toEqual({ code: "123456" });
                stepUpAttempts += 1;
                transport.authStatus =
                    stepUpAttempts < 3
                        ? rotatedAuthenticatedStatus
                        : latestAuthenticatedStatus;
                return Promise.resolve({
                    method: "totp",
                    session: {
                        ...(stepUpAttempts < 3 ? rotatedSession : latestSession),
                        authMethod: "totp",
                    },
                    verifiedAtMs: timestampMs,
                });
            }
            if (path === "accountSecurity.beginWebAuthnEnrollment") {
                expect(input).toEqual({});
                beginAttempts += 1;
                if (beginAttempts === 1) {
                    throw Object.assign(new Error("Step-up required"), {
                        data: { code: "FORBIDDEN", reason: "step_up_required" },
                    });
                }
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
        const queryClient = renderAccountSecurity(
            transport,
            webAuthnClient,
            (collections) => collections,
            true,
            (coordinator) => {
                securityVerification = coordinator;
            }
        );
        const userActions = userEvent.setup();
        const addSecurityKeyButton = await screen.findByRole("button", {
            name: "Add security key",
        });
        if (securityVerification === undefined) {
            throw new TypeError("Missing security verification coordinator");
        }
        const coordinator = securityVerification;
        transport.authStatusQueryHandler = () => {
            const requestIndex = reconciliationRequestCount;
            const response = reconciliationResponses[requestIndex];
            reconciliationRequestCount += 1;
            if (requestIndex === 1) secondReconciliationStarted.resolve();
            if (requestIndex === 2) thirdReconciliationStarted.resolve();
            return (
                response?.promise ??
                Promise.reject(new TypeError("Unexpected auth status reconciliation"))
            );
        };

        await userActions.click(addSecurityKeyButton);
        fireEvent.change(screen.getByLabelText("Name"), {
            target: { value: credential.label },
        });
        await userActions.click(screen.getByRole("button", { name: "Continue" }));

        const verificationDialog = await screen.findByRole("dialog", {
            name: "Verify your session",
        });
        await userActions.click(
            within(verificationDialog).getByRole("button", {
                name: "Use authenticator app",
            })
        );
        fireEvent.change(
            within(verificationDialog).getByLabelText("Authenticator code"),
            { target: { value: "123456" } }
        );
        await act(async () => {
            within(verificationDialog)
                .getByRole("button", { name: "Verify authenticator" })
                .click();
            await registrationStarted.promise;
        });
        expect(
            screen.getByRole("dialog", { hidden: true, name: "Add security key" })
        ).toBeTruthy();

        await act(async () => {
            registration.resolve(registrationResponse);
            await Promise.resolve();
        });

        expect(await screen.findByText(credential.label)).toBeTruthy();
        await waitFor(() => expect(reconciliationRequestCount).toBe(1));
        const staleGeneration = coordinator.getSnapshot().generation;
        expect(coordinator.getSnapshot()).toMatchObject({
            phase: "reconciling",
            protectedInteraction: true,
        });
        async function submitTotpProof(generation: number): Promise<void> {
            const dialog = await screen.findByRole("dialog", {
                name: "Verify your session",
            });
            await userActions.click(
                within(dialog).getByRole("button", {
                    name: "Use authenticator app",
                })
            );
            fireEvent.change(within(dialog).getByLabelText("Authenticator code"), {
                target: { value: "123456" },
            });
            await userActions.click(
                within(dialog).getByRole("button", {
                    name: "Verify authenticator",
                })
            );
            await waitFor(() =>
                expect(coordinator.getSnapshot()).toMatchObject({
                    generation,
                    phase: "reconciling",
                })
            );
        }

        act(() => {
            expect(coordinator.abortActiveFlow()).toBeTrue();
            expect(coordinator.promptProactively("step_up_required")).toBeTrue();
        });
        expect(coordinator.getSnapshot()).toMatchObject({
            generation: staleGeneration + 1,
            phase: "prompting",
            protectedInteraction: false,
        });
        await submitTotpProof(staleGeneration + 1);
        expect(reconciliationRequestCount).toBe(1);

        await act(async () => {
            staleQueryReconciliation.resolve({ state: "anonymous" });
            await secondReconciliationStarted.promise;
        });
        expect(reconciliationRequestCount).toBe(2);
        expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
            authenticatedStatus
        );
        expect(coordinator.getSnapshot()).toMatchObject({
            generation: staleGeneration + 1,
            phase: "reconciling",
        });
        const publicationCancellationStarted = Promise.withResolvers<void>();
        const publicationCancellationGate = Promise.withResolvers<void>();
        const originalCancelQueries = queryClient.cancelQueries.bind(queryClient);
        let blockNextAuthenticationPublication = true;
        const cancelQueries = spyOn(queryClient, "cancelQueries").mockImplementation(
            async (filters, options) => {
                if (blockNextAuthenticationPublication) {
                    blockNextAuthenticationPublication = false;
                    expect(filters).toEqual({
                        exact: true,
                        queryKey: authStatusQueryKey,
                    });
                    await originalCancelQueries(filters, options);
                    publicationCancellationStarted.resolve();
                    await publicationCancellationGate.promise;
                    return;
                }
                return originalCancelQueries(filters, options);
            }
        );
        try {
            await act(async () => {
                stalePublicationReconciliation.resolve(rotatedAuthenticatedStatus);
                await publicationCancellationStarted.promise;
            });
            expect(coordinator.getSnapshot()).toMatchObject({
                generation: staleGeneration + 1,
                phase: "cache-reset",
            });

            act(() => {
                expect(coordinator.abortActiveFlow()).toBeTrue();
                expect(coordinator.promptProactively("step_up_required")).toBeTrue();
            });
            expect(coordinator.getSnapshot()).toMatchObject({
                generation: staleGeneration + 2,
                phase: "prompting",
            });
            await submitTotpProof(staleGeneration + 2);
            expect(reconciliationRequestCount).toBe(2);

            await act(async () => {
                publicationCancellationGate.resolve();
                await thirdReconciliationStarted.promise;
            });
            expect(reconciliationRequestCount).toBe(3);
            expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
                authenticatedStatus
            );
            expect(coordinator.getSnapshot()).toMatchObject({
                generation: staleGeneration + 2,
                phase: "reconciling",
            });
        } finally {
            publicationCancellationGate.resolve();
            cancelQueries.mockRestore();
        }

        const currentFlowCompletion = coordinator.waitForCacheReset();
        await act(async () => {
            currentReconciliation.resolve(latestAuthenticatedStatus);
            expect(await currentFlowCompletion).toBe("completed");
        });
        expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
            latestAuthenticatedStatus
        );
        expect(coordinator.getSnapshot().phase).toBe("idle");
        expect(beginAttempts).toBe(2);
        expect(stepUpAttempts).toBe(3);
        expect(registrationInputs).toEqual([registrationOptions]);
    });

    test("does not begin MFA enrollment before the name step continues", async () => {
        const transport = new SecurityTransport(disabledSummary);
        renderAccountSecurity(transport);
        const userActions = userEvent.setup();
        const addAuthenticatorButton = await screen.findByRole("button", {
            name: "Add authenticator app",
        });

        await userActions.click(addAuthenticatorButton);
        const authenticatorName = screen.getByLabelText("Name");
        expect(authenticatorName).toHaveFocus();
        await userActions.type(authenticatorName, "Phone authenticator");
        await userActions.click(screen.getByRole("button", { name: "Cancel" }));
        await waitForDialogExit();
        expect(addAuthenticatorButton).toHaveFocus();
        expect(transport.calls.filter((call) => call.kind === "mutation")).toHaveLength(
            0
        );

        const addSecurityKeyButton = screen.getByRole("button", {
            name: "Add security key",
        });
        await userActions.click(addSecurityKeyButton);
        expect(screen.getByLabelText("Name")).toHaveFocus();
        await userActions.keyboard("{Escape}");
        await waitForDialogExit();
        expect(addSecurityKeyButton).toHaveFocus();
        expect(transport.calls.filter((call) => call.kind === "mutation")).toHaveLength(
            0
        );
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
                case "accountSecurity.disableMfa": {
                    expect(input).toEqual({ password: "current password" });
                    transport.summary = disabledSummary;
                    return Promise.resolve({
                        disabled: true,
                        revokedSessions: 1,
                        session: currentSession,
                    });
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

        await userActions.click(screen.getByRole("button", { name: "Create new codes" }));
        expect(
            transport.calls.filter(
                (call) => call.path === "accountSecurity.rotateRecoveryCodes"
            )
        ).toHaveLength(0);
        await userActions.click(
            within(
                screen.getByRole("dialog", { name: "Create new recovery codes?" })
            ).getByRole("button", { name: "Create new recovery codes" })
        );
        const recoveryDialog = await screen.findByRole("dialog", {
            name: "Save recovery codes now",
        });
        expect(within(recoveryDialog).getByText(codes[0]!)).toBeTruthy();
        await userActions.click(
            within(recoveryDialog).getByRole("button", { name: "Close dialog" })
        );
        await waitForDialogExit();
        expect(screen.queryByText(codes[0]!)).toBeNull();

        await userActions.click(screen.getByRole("button", { name: "Disable" }));
        let disableDialog = screen.getByRole("dialog", {
            name: "Disable two-step login",
        });
        await userActions.click(
            within(disableDialog).getByRole("button", { name: "Cancel" })
        );
        await waitForDialogExit();

        await userActions.click(screen.getByRole("button", { name: "Disable" }));
        disableDialog = screen.getByRole("dialog", { name: "Disable two-step login" });
        fireEvent.change(within(disableDialog).getByLabelText("Current password"), {
            target: { value: "current password" },
        });
        await userActions.click(
            within(disableDialog).getByRole("button", { name: "Turn off MFA" })
        );
        await waitForDialogExit();
        await screen.findByText("Not enabled");
        expect(
            transport.calls.filter((call) => call.path === "accountSecurity.disableMfa")
        ).toHaveLength(1);
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
            screen.getByRole("button", { name: /Manage access tokens/u })
        );
        await screen.findByText(automationCredential.label);
        await userActions.click(
            screen.getByRole("button", {
                name: `Revoke access token ${automationCredential.label}`,
            })
        );
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.revokeCredential"
            )
        ).toHaveLength(0);
        await userActions.click(
            screen.getByRole("button", { name: "Revoke access token" })
        );
        expect(await screen.findByText(/^Created .* · revoked /u)).toBeTruthy();
        await waitForDialogExit();
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.revokeCredential"
            )
        ).toHaveLength(1);

        await userActions.click(
            screen.getByRole("button", {
                name: `Disable automation account ${automationPrincipal.label}`,
            })
        );
        expect(
            transport.calls.filter(
                (call) => call.path === "automationSecurity.disablePrincipal"
            )
        ).toHaveLength(0);
        await userActions.click(screen.getByRole("button", { name: "Disable account" }));
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

    test("keeps cached credentials visible and retries a failed refresh", async () => {
        const transport = new SecurityTransport();
        transport.principals = [automationPrincipal];
        transport.credentials.set(automationPrincipal.id, [automationCredential]);
        const queryClient = renderAccountSecurity(transport);
        const userActions = userEvent.setup();

        await screen.findByText(automationPrincipal.label);
        await userActions.click(
            screen.getByRole("button", { name: /Manage access tokens/u })
        );
        await screen.findByText(automationCredential.label);
        const credentialKey = automationCredentialsQueryKey(automationPrincipal.id);
        queryClient.setQueryDefaults(credentialKey, { retry: false });
        transport.credentialListQueryHandler = () =>
            Promise.reject(new TypeError("redacted credential refresh failure"));
        await act(async () => {
            await queryClient.invalidateQueries({ queryKey: credentialKey });
        });

        expect(screen.getByText(automationCredential.label)).toBeTruthy();
        expect(screen.queryByText(/redacted credential refresh failure/u)).toBeNull();
        const retry = await screen.findByRole("button", { name: "Try again" });
        transport.credentialListQueryHandler = undefined;
        await userActions.click(retry);
        await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
        expect(screen.getByText(automationCredential.label)).toBeTruthy();
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
            screen.getByRole("button", { name: /Manage access tokens/u })
        );

        const credentialLabel = await screen.findByText(expiredCredential.label);
        const credentialItem = credentialLabel.closest("li");
        expect(credentialItem?.textContent).toContain("expired ");
        expect(
            screen.queryByRole("button", {
                name: `Create replacement access token for ${expiredCredential.label}`,
            })
        ).toBeNull();
        expect(
            screen.queryByRole("button", {
                name: `Revoke access token ${expiredCredential.label}`,
            })
        ).toBeNull();
    });

    test("revokes one, other, and all browser sessions with final cache teardown", async () => {
        const transport = new SecurityTransport();
        const remainingOtherSession = {
            ...otherSession,
            id: "d".repeat(32),
            userAgent: "Remaining browser",
        } satisfies AuthSessionSummary;
        transport.sessions = [currentSession, otherSession, remainingOtherSession];
        transport.mutationHandler = (path, input) => {
            if (path === "auth.revokeSession") {
                expect(input).toEqual({ sessionId: otherSession.id });
                transport.sessions = [currentSession, remainingOtherSession];
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
            screen.getByRole("button", { name: "Revoke Other browser" })
        );
        expect(screen.getByRole("dialog", { name: "Revoke this session?" })).toBeTruthy();
        expect(
            transport.calls.filter((call) => call.path === "auth.revokeSession")
        ).toHaveLength(0);
        await userActions.click(
            within(
                screen.getByRole("dialog", { name: "Revoke this session?" })
            ).getByRole("button", { name: "Revoke" })
        );
        await waitFor(() => expect(screen.queryByText("Other browser")).toBeNull());
        await waitForDialogExit();
        await userActions.click(screen.getByRole("button", { name: "Log out others" }));
        await userActions.click(
            within(
                screen.getByRole("dialog", { name: "Log out every other browser?" })
            ).getByRole("button", { name: "Log out others" })
        );
        await waitFor(() =>
            expect(
                transport.calls.filter((call) => call.path === "auth.revokeOtherSessions")
            ).toHaveLength(1)
        );
        await waitForDialogExit();
        await userActions.click(screen.getByRole("button", { name: "Log out all" }));
        await userActions.click(
            within(
                screen.getByRole("dialog", { name: "Log out every browser?" })
            ).getByRole("button", { name: "Log out all" })
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

    test("preserves a created automation token through stale-auth step-up and session rotation", async () => {
        const transport = new SecurityTransport();
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
        const webAuthnInputs: WebAuthnAuthenticationOptions[] = [];
        const webAuthnClient: DashboardWebAuthnClient = Object.freeze({
            authenticate: (options: WebAuthnAuthenticationOptions) => {
                webAuthnInputs.push(options);
                return Promise.resolve(authenticationResponse);
            },
            register: () => Promise.reject(new TypeError("Unexpected registration")),
        });
        const token = `${automationCredential.prefix}.${"d".repeat(64)}`;
        const operationReplayed = Promise.withResolvers<void>();
        let createAttempts = 0;
        transport.mutationHandler = (path, input) => {
            if (path === "accountSecurity.stepUpTotp") {
                expect(input).toEqual({ code: "123456" });
                throw Object.assign(new Error("Safe authenticator proof failure"), {
                    data: { code: "UNAUTHORIZED" },
                });
            }
            if (path === "accountSecurity.stepUpRecovery") {
                expect(input).toEqual({ code: recoveryCodes()[0] });
                transport.authStatus = rotatedAuthenticatedStatus;
                return Promise.resolve({
                    method: "recovery",
                    recoveryCodesRemaining: 9,
                    session: { ...rotatedSession, authMethod: "recovery" },
                    verifiedAtMs: timestampMs,
                });
            }
            if (path === "accountSecurity.beginWebAuthnStepUp") {
                expect(input).toEqual({});
                return Promise.resolve({
                    expiresAtMs: timestampMs + 60_000,
                    options: authenticationOptions,
                });
            }
            if (path === "accountSecurity.stepUpWebAuthn") {
                expect(input).toEqual({ response: authenticationResponse });
                throw Object.assign(new Error("Safe security-key proof failure"), {
                    data: { code: "UNAUTHORIZED" },
                });
            }
            expect(path).toBe("automationSecurity.createPrincipal");
            expect(input).toEqual({
                capabilities: ["notifications:read"],
                id: automationPrincipal.id,
                initialCredential: { label: automationCredential.label },
                label: automationPrincipal.label,
            });
            createAttempts += 1;
            if (createAttempts === 1) {
                throw Object.assign(new Error("Step-up required"), {
                    data: { code: "FORBIDDEN", reason: "step_up_required" },
                });
            }
            transport.principals = [automationPrincipal];
            transport.credentials.set(automationPrincipal.id, [automationCredential]);
            operationReplayed.resolve();
            return Promise.resolve({
                credential: automationCredential,
                principal: automationPrincipal,
                token,
            });
        };
        const queryClient = renderAccountSecurity(
            transport,
            webAuthnClient,
            (collections) => collections,
            true
        );
        const userActions = userEvent.setup();
        await screen.findByRole("heading", {
            level: 3,
            name: "Create automation account",
        });

        await userActions.type(
            screen.getByLabelText("Account ID"),
            automationPrincipal.id
        );
        await userActions.type(
            screen.getByLabelText("Account name"),
            automationPrincipal.label
        );
        await userActions.type(
            screen.getByLabelText("First token name"),
            automationCredential.label
        );
        await userActions.click(screen.getByLabelText("notifications:read"));
        await userActions.click(
            screen.getByRole("button", { name: "Create account and token" })
        );

        const verificationDialog = await screen.findByRole("dialog", {
            name: "Verify your session",
        });
        await userActions.click(
            within(verificationDialog).getByRole("button", {
                name: "Use authenticator app",
            })
        );
        fireEvent.change(
            within(verificationDialog).getByLabelText("Authenticator code"),
            { target: { value: "123456" } }
        );
        await userActions.click(
            within(verificationDialog).getByRole("button", {
                name: "Verify authenticator",
            })
        );
        expect(
            await within(verificationDialog).findByText(
                "The credentials or session are no longer valid."
            )
        ).toBeTruthy();
        await userActions.click(
            within(verificationDialog).getByRole("button", {
                name: "Choose another method",
            })
        );
        await userActions.click(
            within(verificationDialog).getByRole("button", {
                name: "Use security key",
            })
        );
        expect(
            await within(verificationDialog).findByText(
                "The credentials or session are no longer valid."
            )
        ).toBeTruthy();
        await userActions.click(
            within(verificationDialog).getByRole("button", {
                name: "Use recovery code",
            })
        );
        fireEvent.change(within(verificationDialog).getByLabelText("Recovery code"), {
            target: { value: recoveryCodes()[0] },
        });
        await submitGlobalProofAndWaitForRefresh(
            queryClient,
            operationReplayed.promise,
            "Use recovery code"
        );

        const tokenDialog = await screen.findByRole("dialog", {
            name: "Save access token now",
        });
        expect(within(tokenDialog).getByText(token)).toBeTruthy();
        expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
            rotatedAuthenticatedStatus
        );
        expect(createAttempts).toBe(2);
        expect(webAuthnInputs).toEqual([authenticationOptions]);
        expect(cachedData(queryClient)).not.toContain(token);
        await userActions.click(
            within(tokenDialog).getByRole("button", { name: "Dismiss" })
        );
        await waitForDialogExit();
        expect(screen.queryByText(token)).toBeNull();
        expect(await screen.findByText(automationPrincipal.label)).toBeTruthy();
    }, 15_000);

    test("preserves a rotated automation token through stale-auth step-up and session rotation", async () => {
        const transport = new SecurityTransport(disabledSummary);
        const replacementLabel = "August rotation";
        const replacementCredential = Object.freeze({
            ...automationCredential,
            createdAtMs: timestampMs + 1,
            id: "019fd979-42cc-7ce4-8392-3de63748a595",
            label: replacementLabel,
            prefix: "e".repeat(32),
            replacesCredentialId: automationCredential.id,
        } satisfies AutomationCredentialSummary);
        const token = `${replacementCredential.prefix}.${"f".repeat(64)}`;
        const operationReplayed = Promise.withResolvers<void>();
        let rotateAttempts = 0;
        transport.principals = [automationPrincipal];
        transport.credentials.set(automationPrincipal.id, [automationCredential]);
        transport.mutationHandler = (path, input) => {
            if (path === "accountSecurity.reauthenticatePassword") {
                expect(input).toEqual({ password: "current password" });
                transport.authStatus = rotatedAuthenticatedStatus;
                return Promise.resolve({
                    session: rotatedSession,
                    verifiedAtMs: timestampMs,
                });
            }
            expect(path).toBe("automationSecurity.rotateCredential");
            expect(input).toEqual({
                credentialId: automationCredential.id,
                expectedAuthorizationVersion: automationPrincipal.authorizationVersion,
                principalId: automationPrincipal.id,
                replacement: { label: replacementLabel },
            });
            rotateAttempts += 1;
            if (rotateAttempts === 1) {
                throw Object.assign(new Error("Step-up required"), {
                    data: { code: "FORBIDDEN", reason: "step_up_required" },
                });
            }
            transport.principals = [
                Object.freeze({
                    ...automationPrincipal,
                    activeCredentialCount: 2,
                    authorizationVersion: 2,
                    totalCredentialCount: 2,
                    updatedAtMs: timestampMs + 1,
                }),
            ];
            transport.credentials.set(automationPrincipal.id, [
                replacementCredential,
                automationCredential,
            ]);
            operationReplayed.resolve();
            return Promise.resolve({ credential: replacementCredential, token });
        };
        const queryClient = renderAccountSecurity(
            transport,
            unexpectedWebAuthnClient,
            (collections) => collections,
            true
        );
        const userActions = userEvent.setup();
        await screen.findByText(automationPrincipal.label);

        await userActions.click(
            screen.getByRole("button", { name: /Manage access tokens/u })
        );
        await screen.findByText(automationCredential.label);
        await userActions.type(screen.getByLabelText("New token name"), replacementLabel);
        await userActions.click(
            screen.getByRole("button", {
                name: `Create replacement access token for ${automationCredential.label}`,
            })
        );

        const verificationDialog = await screen.findByRole("dialog", {
            name: "Verify current password",
        });
        fireEvent.change(within(verificationDialog).getByLabelText("Current password"), {
            target: { value: "current password" },
        });
        await submitGlobalProofAndWaitForRefresh(
            queryClient,
            operationReplayed.promise,
            "Verify password"
        );

        const tokenDialog = await screen.findByRole("dialog", {
            name: "Save access token now",
        });
        expect(within(tokenDialog).getByText(token)).toBeTruthy();
        expect(queryClient.getQueryData<AuthStatus>(authStatusQueryKey)).toEqual(
            rotatedAuthenticatedStatus
        );
        expect(rotateAttempts).toBe(2);
        expect(cachedData(queryClient)).not.toContain(token);
        await userActions.click(
            within(tokenDialog).getByRole("button", { name: "Dismiss" })
        );
        await waitForDialogExit();
        expect(screen.queryByText(token)).toBeNull();
        expect(transport.credentials.get(automationPrincipal.id)).toContain(
            replacementCredential
        );
    }, 15_000);
});
