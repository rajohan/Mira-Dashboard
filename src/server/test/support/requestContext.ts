import { maxTime } from "date-fns/constants";

import type {
    ApplicationCapability,
    RequestAuthentication,
} from "../../../contracts/security.ts";
import type { AuthenticationLifecycleService } from "../../domains/security/authenticationLifecycle.ts";
import type { AuthenticationResolution } from "../../domains/security/authenticationResolution.ts";
import type {
    AuthenticationVerificationWorkOptions,
    AuthenticationWorkRuntimeService,
} from "../../domains/security/authenticationWorkGate.ts";
import type { AutomationSecurityLifecycleService } from "../../domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../../domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../../domains/security/mfa/loginLifecycle.ts";
import type {
    ApplicationRuntime,
    RealtimeEventRuntimeService,
} from "../../platform/runtime/applicationRuntime.ts";
import { readAuthenticationHttpCredentials } from "../../rawHttp/authenticationCredentials.ts";
import {
    type AuthenticateCredential,
    createRequestContext,
    type RequestContext,
} from "../../trpc/context.ts";

const anonymousAuthentication: RequestAuthentication = { kind: "anonymous" };

export const testSecurityUserId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
export const testSessionSelector = "a".repeat(32);
export const testAutomationCredentialId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";

/**
 * Creates one valid session identity with the requested test capabilities.
 * @param capabilities Capabilities granted to the test user.
 * @returns A valid session request identity.
 */
export function createTestSessionAuthentication(
    capabilities: readonly ApplicationCapability[]
): RequestAuthentication {
    return {
        kind: "authenticated",
        principal: {
            authorizationVersion: 1,
            capabilities: [...capabilities],
            authenticatorId: testSessionSelector,
            id: testSecurityUserId,
            kind: "session",
        },
    };
}

/**
 * Creates one valid automation identity with the requested test capabilities.
 * @param capabilities Capabilities granted to the test automation principal.
 * @returns A valid automation request identity.
 */
export function createTestAutomationAuthentication(
    capabilities: readonly ApplicationCapability[]
): RequestAuthentication {
    return {
        kind: "authenticated",
        principal: {
            authorizationVersion: 1,
            capabilities: [...capabilities],
            authenticatorId: testAutomationCredentialId,
            id: "test-automation",
            kind: "automation",
        },
    };
}

/**
 * Builds a stable test resolution whose lease revalidates the same identity.
 * @param authentication Test request identity.
 * @returns Authentication-service output accepted by request-context creation.
 */
export function createTestAuthenticationResolution(
    authentication: RequestAuthentication
): AuthenticationResolution {
    if (authentication.kind !== "authenticated") {
        return Object.freeze({ authentication });
    }
    const resolution: AuthenticationResolution = Object.freeze({
        authentication,
        lease: Object.freeze({
            expiresAtMs: maxTime,
            revalidate: () => Promise.resolve(resolution),
        }),
    });
    return resolution;
}

interface TestApplicationRuntimeOverrides {
    readonly authentication?: AuthenticationWorkRuntimeService;
    readonly dispose?: ApplicationRuntime["dispose"];
    readonly initialize?: ApplicationRuntime["initialize"];
    readonly stream?: RealtimeEventRuntimeService["stream"];
}

const inertAuthenticationWorkGate: AuthenticationWorkRuntimeService["passwordWorkGate"] =
    Object.freeze({
        async run<T>(work: () => Promise<T>, signal?: AbortSignal) {
            signal?.throwIfAborted();
            return { accepted: true as const, value: await work() };
        },
    });

function runInertAuthenticationVerification<T>(
    work: (signal: AbortSignal) => Promise<T>,
    options: AuthenticationVerificationWorkOptions<T>
): Promise<T> {
    options.signal?.throwIfAborted();
    const decision = options.onBeforeStart?.() ?? { proceed: true as const };
    if (!decision.proceed) return Promise.resolve(decision.value);
    const signal = options.signal ?? new AbortController().signal;
    return work(signal).then((value) => {
        options.onResultBeforeRelease?.(value);
        return value;
    });
}

const inertAuthenticationRuntime: AuthenticationWorkRuntimeService = Object.freeze({
    passwordWorkGate: inertAuthenticationWorkGate,
    totpWorkGate: inertAuthenticationWorkGate,
    runGatewayVerification: runInertAuthenticationVerification,
    runWebAuthnVerification: runInertAuthenticationVerification,
});

/**
 * Creates an inert mutable-auth service that individual tests can override.
 * @param overrides Lifecycle methods exercised by the current test.
 * @returns A complete inert lifecycle service with requested overrides.
 */
export function createTestAuthenticationLifecycleService(
    overrides: Partial<AuthenticationLifecycleService> = {}
): AuthenticationLifecycleService {
    return Object.freeze({
        bootstrap:
            overrides.bootstrap ?? (() => Promise.resolve({ status: "closed" as const })),
        changePassword:
            overrides.changePassword ??
            (() => Promise.resolve({ status: "session-changed" as const })),
        listSessions: overrides.listSessions ?? (() => []),
        login:
            overrides.login ??
            (() => Promise.resolve({ status: "bootstrap-required" as const })),
        logout: overrides.logout ?? (() => false),
        revokeSession: overrides.revokeSession ?? (() => ({ revoked: false })),
        status:
            overrides.status ??
            (() => ({ authenticated: false, isBootstrapRequired: false })),
        touchSession: overrides.touchSession ?? ((): undefined => {}),
    });
}

/**
 * Creates a fail-closed automation-security lifecycle for transport tests.
 * @param overrides Lifecycle methods exercised by the current test.
 * @returns A complete inert automation-security service.
 */
export function createTestAutomationSecurityLifecycleService(
    overrides: Partial<AutomationSecurityLifecycleService> = {}
): AutomationSecurityLifecycleService {
    return Object.freeze({
        createCredential:
            overrides.createCredential ?? (() => ({ status: "session-changed" })),
        createPrincipal:
            overrides.createPrincipal ?? (() => ({ status: "session-changed" })),
        disablePrincipal:
            overrides.disablePrincipal ?? (() => ({ status: "session-changed" })),
        listCredentials:
            overrides.listCredentials ?? (() => ({ status: "session-changed" })),
        listPrincipals:
            overrides.listPrincipals ?? (() => ({ status: "session-changed" })),
        replaceCapabilities:
            overrides.replaceCapabilities ?? (() => ({ status: "session-changed" })),
        revokeCredential:
            overrides.revokeCredential ?? (() => ({ status: "session-changed" })),
        rotateCredential:
            overrides.rotateCredential ?? (() => ({ status: "session-changed" })),
    });
}

/**
 * Creates an inert account-security lifecycle that individual tests can override.
 * @param overrides Account-security methods exercised by the current test.
 * @returns A complete lifecycle service with fail-closed defaults.
 */
export function createTestMfaAccountLifecycleService(
    overrides: Partial<MfaAccountLifecycleService> = {}
): MfaAccountLifecycleService {
    return Object.freeze({
        beginWebAuthnEnrollment:
            overrides.beginWebAuthnEnrollment ??
            (() => Promise.resolve({ status: "session-changed" })),
        beginWebAuthnStepUp:
            overrides.beginWebAuthnStepUp ??
            (() => Promise.resolve({ status: "session-changed" })),
        beginTotpEnrollment:
            overrides.beginTotpEnrollment ??
            (() => Promise.resolve({ status: "session-changed" })),
        confirmTotpEnrollment:
            overrides.confirmTotpEnrollment ??
            (() => Promise.resolve({ status: "session-changed" })),
        confirmWebAuthnEnrollment:
            overrides.confirmWebAuthnEnrollment ??
            (() => Promise.resolve({ status: "session-changed" })),
        disableMfa:
            overrides.disableMfa ??
            (() => Promise.resolve({ status: "session-changed" })),
        reauthenticatePassword:
            overrides.reauthenticatePassword ??
            (() => Promise.resolve({ status: "session-changed" })),
        removeTotpFactor:
            overrides.removeTotpFactor ?? (() => ({ status: "session-changed" })),
        removeWebAuthnCredential:
            overrides.removeWebAuthnCredential ?? (() => ({ status: "session-changed" })),
        rotateRecoveryCodes:
            overrides.rotateRecoveryCodes ??
            (() => Promise.resolve({ status: "session-changed" })),
        stepUpRecovery:
            overrides.stepUpRecovery ??
            (() => Promise.resolve({ status: "session-changed" })),
        stepUpTotp:
            overrides.stepUpTotp ??
            (() => Promise.resolve({ status: "session-changed" })),
        stepUpWebAuthn:
            overrides.stepUpWebAuthn ??
            (() => Promise.resolve({ status: "session-changed" })),
        summary: overrides.summary ?? (() => ({ status: "session-changed" })),
    });
}

/**
 * Creates an inert login-MFA lifecycle that fails closed unless explicitly overridden.
 * @param overrides Login-MFA methods exercised by the current test.
 * @returns A complete lifecycle service with unavailable or absent defaults.
 */
export function createTestMfaLoginLifecycleService(
    overrides: Partial<MfaLoginLifecycleService> = {}
): MfaLoginLifecycleService {
    return Object.freeze({
        beginPendingLogin:
            overrides.beginPendingLogin ??
            (() => ({ status: "mfa-unavailable" as const })),
        beginWebAuthnLogin:
            overrides.beginWebAuthnLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        completeRecoveryLogin:
            overrides.completeRecoveryLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        completeTotpLogin:
            overrides.completeTotpLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        completeWebAuthnLogin:
            overrides.completeWebAuthnLogin ??
            (() => Promise.resolve({ status: "service-unavailable" })),
        pendingLoginSummary: overrides.pendingLoginSummary ?? ((): undefined => {}),
        revokePendingLogin: overrides.revokePendingLogin ?? (() => false),
    });
}

export interface TestServerSecurityServices {
    readonly authenticateCredential: AuthenticateCredential;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
}

/**
 * Creates required fail-closed security dependencies for generic server tests.
 * @param overrides Security services exercised by the current test.
 * @returns A complete security dependency bundle.
 */
export function createTestServerSecurityServices(
    overrides: Partial<TestServerSecurityServices> = {}
): TestServerSecurityServices {
    return {
        authenticateCredential:
            overrides.authenticateCredential ??
            (() => ({ authentication: { kind: "anonymous" as const } })),
        authenticationLifecycle:
            overrides.authenticationLifecycle ??
            createTestAuthenticationLifecycleService(),
        automationSecurityLifecycle:
            overrides.automationSecurityLifecycle ??
            createTestAutomationSecurityLifecycleService(),
        mfaAccountLifecycle:
            overrides.mfaAccountLifecycle ?? createTestMfaAccountLifecycleService(),
        mfaLoginLifecycle:
            overrides.mfaLoginLifecycle ?? createTestMfaLoginLifecycleService(),
    };
}

/**
 * Creates a lifecycle-safe runtime stub for transport and composition tests.
 * @param overrides Runtime methods exercised by the current test.
 * @returns A complete inert runtime with the requested overrides.
 */
export function createTestApplicationRuntime(
    overrides: TestApplicationRuntimeOverrides = {}
): ApplicationRuntime {
    return Object.freeze({
        dispose: overrides.dispose ?? (() => Promise.resolve()),
        initialize: overrides.initialize ?? (() => Promise.resolve()),
        services: Object.freeze({
            authentication: overrides.authentication ?? inertAuthenticationRuntime,
            realtimeEvents: Object.freeze({
                stream:
                    overrides.stream ??
                    (() =>
                        Promise.reject(
                            new Error("Test application runtime has no realtime stream")
                        )),
            }),
        }),
    });
}

/**
 * Creates an explicitly authenticated or anonymous request context for tests.
 * @param authentication Validated identity state supplied to request context creation.
 * @param applicationRuntime Process runtime exposed through the context.
 * @returns A validated test request context.
 */
export function createTestRequestContext(
    authentication: RequestAuthentication = anonymousAuthentication,
    applicationRuntime = createTestApplicationRuntime(),
    options: {
        readonly authenticationClientSourceId?: string;
        readonly authenticationLifecycle?: AuthenticationLifecycleService;
        readonly automationSecurityLifecycle?: AutomationSecurityLifecycleService;
        readonly mfaAccountLifecycle?: MfaAccountLifecycleService;
        readonly mfaLoginLifecycle?: MfaLoginLifecycleService;
        readonly request?: Request;
        readonly responseHeaders?: Headers;
    } = {}
): Promise<RequestContext> {
    const request = options.request ?? new Request("http://localhost/trpc/test");
    const credentials = readAuthenticationHttpCredentials(request);
    return createRequestContext({
        applicationRuntime,
        authenticationCredential: credentials.authentication,
        authenticationClientSourceId:
            options.authenticationClientSourceId ?? "test-client-source",
        authenticationLifecycle:
            options.authenticationLifecycle ?? createTestAuthenticationLifecycleService(),
        automationSecurityLifecycle:
            options.automationSecurityLifecycle ??
            createTestAutomationSecurityLifecycleService(),
        authenticateCredential: () => createTestAuthenticationResolution(authentication),
        mfaAccountLifecycle:
            options.mfaAccountLifecycle ?? createTestMfaAccountLifecycleService(),
        mfaLoginLifecycle:
            options.mfaLoginLifecycle ?? createTestMfaLoginLifecycleService(),
        pendingLoginCredential: credentials.pendingLogin,
        request,
        responseHeaders: options.responseHeaders ?? new Headers(),
    });
}
