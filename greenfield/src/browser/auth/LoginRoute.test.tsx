import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryHistory } from "@tanstack/react-router";

import type { AuthStatus, PendingLoginSummary } from "../../contracts/auth.ts";
import type {
    WebAuthnAuthenticationOptions,
    WebAuthnAuthenticationResponse,
} from "../../contracts/webauthn.ts";
import { createDashboardQueryClient } from "../api/queryClient.ts";
import {
    createDashboardTrpcClient,
    type DashboardTrpcTransport,
} from "../api/trpcClient.ts";
import { DashboardBrowserApplication } from "../application.tsx";
import { createDashboardRouter } from "../router.tsx";
import type { DashboardWebAuthnClient } from "../security/webauthn/webauthnClient.ts";
import { noOpDashboardRealtimeClient } from "../test/realtime.ts";

const { render, screen, waitFor } = await import("@testing-library/react");
const userEventModule = await import("@testing-library/user-event");
const userEvent = userEventModule.default;

const timestampMs = Date.now();
const user = Object.freeze({
    id: "019fd974-54a2-74dd-a64b-d4186f8d8828",
    username: "operator",
});
const session = Object.freeze({
    authenticatedAtMs: timestampMs,
    authMethod: "password" as const,
    createdAtMs: timestampMs,
    expiresAtMs: timestampMs + 86_400_000,
    id: "a".repeat(32),
    isCurrent: true,
    lastSeenAtMs: timestampMs,
    userAgent: "Dashboard browser test",
});
const authenticatedStatus: AuthStatus = Object.freeze({
    session,
    state: "authenticated",
    user,
});
const pendingLogin: PendingLoginSummary = Object.freeze({
    expiresAtMs: timestampMs + 60_000,
    methods: ["totp", "recovery", "webauthn"] satisfies PendingLoginSummary["methods"],
    username: user.username,
});
const unexpectedWebAuthnClient: DashboardWebAuthnClient = Object.freeze({
    authenticate: () => Promise.reject(new TypeError("Unexpected authentication")),
    register: () => Promise.reject(new TypeError("Unexpected registration")),
});

interface TransportCall {
    readonly input: unknown;
    readonly kind: "mutation" | "query";
    readonly path: string;
}

class AuthenticationTransport implements DashboardTrpcTransport {
    readonly calls: TransportCall[] = [];
    mutationHandler: (path: string, input: unknown) => Promise<unknown> = (path) =>
        Promise.reject(new TypeError(`Unexpected mutation: ${path}`));
    status: AuthStatus;

    constructor(status: AuthStatus) {
        this.status = status;
    }

    mutation(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "mutation", path });
        return this.mutationHandler(path, input);
    }

    query(path: string, input?: unknown): Promise<unknown> {
        this.calls.push({ input, kind: "query", path });
        if (path !== "auth.status") {
            return Promise.reject(new TypeError(`Unexpected query: ${path}`));
        }
        return Promise.resolve(this.status);
    }
}

const queryClients: ReturnType<typeof createDashboardQueryClient>[] = [];

function renderAuthenticationRoute(
    transport: AuthenticationTransport,
    options: {
        readonly initialEntry?: "/" | "/login";
        readonly webAuthnClient?: DashboardWebAuthnClient;
    } = {}
) {
    const queryClient = createDashboardQueryClient();
    queryClients.push(queryClient);
    const router = createDashboardRouter(
        createMemoryHistory({ initialEntries: [options.initialEntry ?? "/login"] })
    );
    render(
        <DashboardBrowserApplication
            queryClient={queryClient}
            realtimeClient={noOpDashboardRealtimeClient}
            router={router}
            trpcClient={createDashboardTrpcClient(transport)}
            webAuthnClient={options.webAuthnClient ?? unexpectedWebAuthnClient}
        />
    );
    return { queryClient, router };
}

function cachedBrowserData(queryClient: ReturnType<typeof createDashboardQueryClient>) {
    return JSON.stringify(
        queryClient
            .getQueryCache()
            .getAll()
            .map((query) => query.state.data)
    );
}

afterEach(() => {
    for (const queryClient of queryClients.splice(0)) queryClient.clear();
});

describe("Dashboard login route", () => {
    test("redirects an anonymous protected route to password sign-in", async () => {
        const transport = new AuthenticationTransport({ state: "anonymous" });
        renderAuthenticationRoute(transport, { initialEntry: "/" });

        expect(
            await screen.findByRole("heading", { level: 1, name: "Sign in" })
        ).toBeTruthy();
        expect(transport.calls.length).toBeGreaterThanOrEqual(2);
        for (const call of transport.calls) {
            expect(call).toEqual({ input: {}, kind: "query", path: "auth.status" });
        }
    });

    test("submits bootstrap secrets ephemerally and enters the authenticated route", async () => {
        const transport = new AuthenticationTransport({
            state: "bootstrap-required",
        });
        const password = "correct horse battery staple";
        const gatewayCredential = "gateway-bootstrap-credential";
        transport.mutationHandler = (path, input) => {
            expect(path).toBe("auth.bootstrap");
            expect(input).toEqual({ gatewayCredential, password, username: "operator" });
            transport.status = authenticatedStatus;
            return Promise.resolve({ session, user });
        };
        const { queryClient } = renderAuthenticationRoute(transport);
        const userActions = userEvent.setup();

        await screen.findByRole("heading", {
            level: 1,
            name: "Secure first-user setup",
        });
        await userActions.type(screen.getByLabelText("Username"), "operator");
        await userActions.type(screen.getByLabelText("Dashboard password"), password);
        await userActions.type(
            screen.getByLabelText("Gateway credential"),
            gatewayCredential
        );
        await userActions.click(screen.getByRole("button", { name: "Create operator" }));

        expect(
            await screen.findByRole("heading", { level: 1, name: "Mira Dashboard" })
        ).toBeTruthy();
        expect(cachedBrowserData(queryClient)).not.toContain(password);
        expect(cachedBrowserData(queryClient)).not.toContain(gatewayCredential);
    });

    test("moves password login into the pending MFA state without caching the password", async () => {
        const transport = new AuthenticationTransport({ state: "anonymous" });
        const password = "correct horse battery staple";
        transport.mutationHandler = (path, input) => {
            expect(path).toBe("auth.login");
            expect(input).toEqual({ password, username: "operator" });
            transport.status = { pendingLogin, state: "pending-mfa" };
            return Promise.resolve({ pendingLogin, status: "mfa-required" });
        };
        const { queryClient } = renderAuthenticationRoute(transport);
        const userActions = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Sign in" });
        await userActions.type(screen.getByLabelText("Username"), "operator");
        await userActions.type(screen.getByLabelText("Password"), password);
        await userActions.click(screen.getByRole("button", { name: "Continue" }));

        expect(
            await screen.findByRole("heading", {
                level: 1,
                name: "Multi-factor authentication",
            })
        ).toBeTruthy();
        expect(cachedBrowserData(queryClient)).not.toContain(password);
        expect(screen.getByLabelText("Authenticator code")).toBeTruthy();
        expect(screen.getByLabelText("Recovery code")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Use a security key" })).toBeTruthy();
    });

    test("keeps TOTP and recovery proofs independent and completes TOTP login", async () => {
        const transport = new AuthenticationTransport({
            pendingLogin,
            state: "pending-mfa",
        });
        const code = "123456";
        transport.mutationHandler = (path, input) => {
            expect(path).toBe("auth.loginTotp");
            expect(input).toEqual({ code });
            transport.status = authenticatedStatus;
            return Promise.resolve({ session, user });
        };
        const { queryClient } = renderAuthenticationRoute(transport);
        const userActions = userEvent.setup();

        await screen.findByRole("heading", {
            level: 1,
            name: "Multi-factor authentication",
        });
        await userActions.type(screen.getByLabelText("Authenticator code"), code);
        expect(screen.getByLabelText<HTMLInputElement>("Recovery code").value).toBe("");
        await userActions.click(screen.getByRole("button", { name: "Verify code" }));

        await screen.findByRole("heading", { level: 1, name: "Mira Dashboard" });
        expect(cachedBrowserData(queryClient)).not.toContain(code);
    });

    test("resyncs pending MFA state when a failed proof clears its cookie", async () => {
        const transport = new AuthenticationTransport({
            pendingLogin,
            state: "pending-mfa",
        });
        transport.mutationHandler = (path, input) => {
            expect(path).toBe("auth.loginTotp");
            expect(input).toEqual({ code: "123456" });
            transport.status = { state: "anonymous" };
            return Promise.reject(
                Object.assign(new Error("Pending login expired"), {
                    data: { code: "UNAUTHORIZED" },
                })
            );
        };
        renderAuthenticationRoute(transport);
        const userActions = userEvent.setup();

        await screen.findByRole("heading", {
            level: 1,
            name: "Multi-factor authentication",
        });
        await userActions.type(screen.getByLabelText("Authenticator code"), "123456");
        await userActions.click(screen.getByRole("button", { name: "Verify code" }));

        expect(
            await screen.findByRole("heading", { level: 1, name: "Sign in" })
        ).toBeTruthy();
        expect(
            screen.queryByRole("heading", {
                level: 1,
                name: "Multi-factor authentication",
            })
        ).toBeNull();
    });

    test("completes recovery-code login without caching the proof", async () => {
        const transport = new AuthenticationTransport({
            pendingLogin,
            state: "pending-mfa",
        });
        const code = `${"a".repeat(32)}-${"b".repeat(32)}`;
        transport.mutationHandler = (path, input) => {
            expect(path).toBe("auth.loginRecovery");
            expect(input).toEqual({ code });
            transport.status = authenticatedStatus;
            return Promise.resolve({ session, user });
        };
        const { queryClient } = renderAuthenticationRoute(transport);
        const userActions = userEvent.setup();

        await screen.findByRole("heading", {
            level: 1,
            name: "Multi-factor authentication",
        });
        await userActions.type(screen.getByLabelText("Recovery code"), code);
        await userActions.click(
            screen.getByRole("button", { name: "Use recovery code" })
        );

        await screen.findByRole("heading", { level: 1, name: "Mira Dashboard" });
        expect(cachedBrowserData(queryClient)).not.toContain(code);
    });

    test("completes WebAuthn with the browser ceremony response wrapped by contract", async () => {
        const transport = new AuthenticationTransport({
            pendingLogin,
            state: "pending-mfa",
        });
        const options: WebAuthnAuthenticationOptions = {
            allowCredentials: [{ id: "AAAAAAAA", type: "public-key" }],
            challenge: "A".repeat(32),
            rpId: "localhost",
            timeout: 60_000,
            userVerification: "required",
        };
        const response: WebAuthnAuthenticationResponse = {
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
        };
        const ceremonyInputs: WebAuthnAuthenticationOptions[] = [];
        const webAuthnClient: DashboardWebAuthnClient = Object.freeze({
            authenticate: (received: WebAuthnAuthenticationOptions) => {
                ceremonyInputs.push(received);
                return Promise.resolve(response);
            },
            register: () => Promise.reject(new TypeError("Unexpected registration")),
        });
        transport.mutationHandler = (path, input) => {
            if (path === "auth.beginWebAuthnLogin") {
                expect(input).toEqual({});
                return Promise.resolve({ expiresAtMs: timestampMs + 60_000, options });
            }
            expect(path).toBe("auth.loginWebAuthn");
            expect(input).toEqual({ response });
            transport.status = authenticatedStatus;
            return Promise.resolve({ session, user });
        };
        renderAuthenticationRoute(transport, { webAuthnClient });
        const userActions = userEvent.setup();

        await screen.findByRole("heading", {
            level: 1,
            name: "Multi-factor authentication",
        });
        await userActions.click(
            screen.getByRole("button", { name: "Use a security key" })
        );

        await screen.findByRole("heading", { level: 1, name: "Mira Dashboard" });
        expect(ceremonyInputs).toEqual([options]);
    });

    test("renders and focuses a fixed safe error without leaking transport details", async () => {
        const transport = new AuthenticationTransport({ state: "anonymous" });
        const privateSentinel = "private-login-sentinel";
        const privateError = Object.assign(new Error(privateSentinel), {
            data: { code: "TOO_MANY_REQUESTS" },
        });
        transport.mutationHandler = () => Promise.reject(privateError);
        renderAuthenticationRoute(transport);
        const userActions = userEvent.setup();

        await screen.findByRole("heading", { level: 1, name: "Sign in" });
        await userActions.type(screen.getByLabelText("Username"), "operator");
        await userActions.type(
            screen.getByLabelText("Password"),
            "correct horse battery staple"
        );
        await userActions.click(screen.getByRole("button", { name: "Continue" }));

        const alert = await screen.findByRole("alert");
        expect(alert.textContent).toContain("Too many attempts");
        expect(alert.textContent).not.toContain(privateSentinel);
        await waitFor(() => expect(document.activeElement).toBe(alert));
    });
});
