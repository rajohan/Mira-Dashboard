import { maxTime } from "date-fns/constants";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";

import type {
    ApplicationCapability,
    RequestAuthentication,
} from "../../../contracts/security.ts";
import type { AgentService } from "../../domains/agents/service.ts";
import { createTestAgentService } from "../../domains/agents/testSupport/service.ts";
import type { MonitoringCatalogService } from "../../domains/monitoring/catalogService.ts";
import type { MonitoringService } from "../../domains/monitoring/service.ts";
import {
    createTestMonitoringCatalogService,
    createTestMonitoringService,
} from "../../domains/monitoring/testSupport/services.ts";
import type { AuthenticationLifecycleService } from "../../domains/security/authenticationLifecycle.ts";
import type { AuthenticationResolution } from "../../domains/security/authenticationResolution.ts";
import type {
    AuthenticationVerificationWorkOptions,
    AuthenticationWorkRuntimeService,
} from "../../domains/security/authenticationWorkGate.ts";
import type { AutomationSecurityLifecycleService } from "../../domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../../domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../../domains/security/mfa/loginLifecycle.ts";
import type { SecurityAuditLifecycleService } from "../../domains/security/securityAuditLifecycle.ts";
import type { TaskService } from "../../domains/tasks/service.ts";
import { createTestTaskService } from "../../domains/tasks/testSupport/service.ts";
import {
    createStructuredLogger,
    type StructuredLogger,
} from "../../platform/observability/structuredLogger.ts";
import type {
    ApplicationRuntime,
    DashboardApplicationRuntime,
    RealtimeEventRuntimeService,
} from "../../platform/runtime/applicationRuntime.ts";
import { readAuthenticationHttpCredentials } from "../../rawHttp/authenticationCredentials.ts";
import {
    type AuthenticateCredential,
    createRequestContext,
    type RequestContext,
} from "../../trpc/context.ts";
import { runTestImmediateDatabaseWrite } from "./databaseWriteAdmission.ts";

const anonymousAuthentication: RequestAuthentication = { kind: "anonymous" };

export const testSecurityUserId = "019fc968-1a9b-7770-8f1b-d5b863b0e7b4";
export const testSessionSelector = "a".repeat(32);
export const testAutomationCredentialId = "019fc968-1a9b-7771-9f1b-d5b863b0e7b4";

const inertStructuredLogSink = Object.freeze({
    write(): undefined {},
});

/**
 * Creates an inert process logger for tests that compose runtime or server roots.
 * @returns A complete structured logger that discards every validated record.
 */
export function createTestStructuredLogger(): StructuredLogger {
    return createStructuredLogger({
        identity: {
            bun: "test-bun",
            pid: 1,
            processRole: "web",
            release: "test-release",
            service: "mira-dashboard",
        },
        sink: inertStructuredLogSink,
    });
}

/** Capturing logger fixture for assertions at application logging boundaries. */
export interface CapturingTestStructuredLogger {
    readonly logger: StructuredLogger;
    readonly logLines: string[];
}

/**
 * Creates a test logger and its captured serialized records.
 * @returns Stable logger fixture with an initially empty record buffer.
 */
export function createCapturingTestStructuredLogger(): CapturingTestStructuredLogger {
    const logLines: string[] = [];
    const logger = createStructuredLogger({
        identity: {
            bun: "test-bun",
            pid: 1,
            processRole: "web",
            release: "test-release",
            service: "mira-dashboard",
        },
        sink: {
            write(line) {
                logLines.push(line);
            },
        },
    });
    return { logger, logLines };
}

/**
 * Waits until the expected number of asynchronous log records remains stable.
 * @param logLines Captured serialized log records.
 * @param expectedCount Exact terminal record count.
 */
export async function waitForTestLogQuiescence(
    logLines: readonly string[],
    expectedCount: number
): Promise<void> {
    let stableObservations = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
        if (logLines.length === expectedCount) {
            stableObservations += 1;
            if (stableObservations === 3) return;
        } else {
            stableObservations = 0;
        }
        await Bun.sleep(5);
    }
    throw new Error(
        `Test log records did not reach a stable expected count: expected ${String(
            expectedCount
        )}, observed ${String(logLines.length)}: ${JSON.stringify(logLines)}`
    );
}

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
    readonly logger?: StructuredLogger;
    readonly shutdownListener?: ApplicationRuntime["shutdownListener"];
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
    return work(signal).then(async (value) => {
        await options.onResultBeforeRelease?.(value);
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
        logout: overrides.logout ?? (() => Promise.resolve(false)),
        revokeAllSessions:
            overrides.revokeAllSessions ??
            (() => Promise.resolve({ revokedSessions: 0 })),
        revokeOtherSessions:
            overrides.revokeOtherSessions ??
            (() => Promise.resolve({ revokedSessions: 0 })),
        revokeSession:
            overrides.revokeSession ?? (() => Promise.resolve({ revoked: false })),
        status:
            overrides.status ??
            (() => ({ authenticated: false, isBootstrapRequired: false })),
        touchSession: overrides.touchSession ?? (() => Promise.resolve(undefined)),
    });
}

/**
 * Creates an inert security-audit lifecycle that fails closed unless overridden.
 * @param overrides Lifecycle methods exercised by the current test.
 * @returns A complete inert security-audit lifecycle.
 */
export function createTestSecurityAuditLifecycleService(
    overrides: Partial<SecurityAuditLifecycleService> = {}
): SecurityAuditLifecycleService {
    return Object.freeze({
        listEvents:
            overrides.listEvents ?? (() => ({ status: "session-changed" as const })),
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
            overrides.createCredential ??
            (() => Promise.resolve({ status: "session-changed" })),
        createPrincipal:
            overrides.createPrincipal ??
            (() => Promise.resolve({ status: "session-changed" })),
        disablePrincipal:
            overrides.disablePrincipal ??
            (() => Promise.resolve({ status: "session-changed" })),
        listCredentials:
            overrides.listCredentials ?? (() => ({ status: "session-changed" })),
        listPrincipals:
            overrides.listPrincipals ?? (() => ({ status: "session-changed" })),
        replaceCapabilities:
            overrides.replaceCapabilities ??
            (() => Promise.resolve({ status: "session-changed" })),
        revokeCredential:
            overrides.revokeCredential ??
            (() => Promise.resolve({ status: "session-changed" })),
        rotateCredential:
            overrides.rotateCredential ??
            (() => Promise.resolve({ status: "session-changed" })),
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
            overrides.removeTotpFactor ??
            (() => Promise.resolve({ status: "session-changed" })),
        removeWebAuthnCredential:
            overrides.removeWebAuthnCredential ??
            (() => Promise.resolve({ status: "session-changed" })),
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
            (() => Promise.resolve({ status: "mfa-unavailable" as const })),
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
        revokePendingLogin:
            overrides.revokePendingLogin ?? (() => Promise.resolve(false)),
    });
}

export interface TestServerSecurityServices {
    readonly agentService: AgentService["Service"];
    readonly authenticateCredential: AuthenticateCredential;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly monitoringCatalogService: MonitoringCatalogService["Service"];
    readonly monitoringService: MonitoringService["Service"];
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly taskService: TaskService["Service"];
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
        agentService: overrides.agentService ?? createTestAgentService(),
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
        monitoringCatalogService:
            overrides.monitoringCatalogService ?? createTestMonitoringCatalogService(),
        monitoringService: overrides.monitoringService ?? createTestMonitoringService(),
        securityAuditLifecycle:
            overrides.securityAuditLifecycle ?? createTestSecurityAuditLifecycleService(),
        taskService: overrides.taskService ?? createTestTaskService(),
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
        logger: overrides.logger ?? createTestStructuredLogger(),
        services: Object.freeze({
            authentication: overrides.authentication ?? inertAuthenticationRuntime,
            realtimeEvents: Object.freeze({
                stream:
                    overrides.stream ??
                    (() =>
                        Promise.reject(
                            new Error("Test application runtime has no realtime stream")
                        )),
                wake: () => Promise.resolve(),
            }),
        }),
        shutdownListener:
            overrides.shutdownListener ??
            ((options) => options.stop(options.forceSignal.aborted)),
    });
}

/**
 * Attaches a test-owned migrated handle to an existing runtime stub or focused runtime.
 * Production composition obtains the same shape from its scoped database Layer.
 * @param applicationRuntime Runtime exercised by the test.
 * @param database Migrated test database retained by the fixture.
 * @returns A Dashboard runtime whose database accessor returns the exact supplied ORM.
 */
export function withTestDashboardDatabase(
    applicationRuntime: ApplicationRuntime,
    database: SQLiteBunDatabase
): DashboardApplicationRuntime {
    return Object.freeze({
        ...applicationRuntime,
        database: Object.freeze({
            orm: () => Promise.resolve(database),
            run: runTestImmediateDatabaseWrite,
        }),
    });
}

/**
 * Creates an inert Dashboard runtime around a migrated test database.
 * @param database Migrated test database retained by the fixture.
 * @param overrides Runtime methods exercised by the current test.
 * @returns A complete Dashboard runtime stub.
 */
export function createTestDashboardApplicationRuntime(
    database: SQLiteBunDatabase,
    overrides: TestApplicationRuntimeOverrides = {}
): DashboardApplicationRuntime {
    return withTestDashboardDatabase(createTestApplicationRuntime(overrides), database);
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
        readonly agentService?: AgentService["Service"];
        readonly authenticationClientSourceId?: string;
        readonly authenticationLifecycle?: AuthenticationLifecycleService;
        readonly automationSecurityLifecycle?: AutomationSecurityLifecycleService;
        readonly mfaAccountLifecycle?: MfaAccountLifecycleService;
        readonly mfaLoginLifecycle?: MfaLoginLifecycleService;
        readonly monitoringCatalogService?: MonitoringCatalogService["Service"];
        readonly monitoringService?: MonitoringService["Service"];
        readonly request?: Request;
        readonly requestId?: string;
        readonly responseHeaders?: Headers;
        readonly securityAuditLifecycle?: SecurityAuditLifecycleService;
        readonly taskService?: TaskService["Service"];
    } = {}
): Promise<RequestContext> {
    const request = options.request ?? new Request("http://localhost/trpc/test");
    const credentials = readAuthenticationHttpCredentials(request);
    return createRequestContext({
        agentService: options.agentService ?? createTestAgentService(),
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
        monitoringCatalogService:
            options.monitoringCatalogService ?? createTestMonitoringCatalogService(),
        monitoringService: options.monitoringService ?? createTestMonitoringService(),
        pendingLoginCredential: credentials.pendingLogin,
        request,
        requestId: options.requestId ?? "test-request-id",
        responseHeaders: options.responseHeaders ?? new Headers(),
        securityAuditLifecycle:
            options.securityAuditLifecycle ?? createTestSecurityAuditLifecycleService(),
        taskService: options.taskService ?? createTestTaskService(),
    });
}
