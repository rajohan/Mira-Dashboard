import type { RequestAuthentication } from "../../contracts/security.ts";
import type { AuthenticationLifecycleService } from "../domains/security/authenticationLifecycle.ts";
import {
    type AuthenticationLease,
    parseAuthenticationResolution,
} from "../domains/security/authenticationResolution.ts";
import type { AutomationSecurityLifecycleService } from "../domains/security/automation/lifecycle.ts";
import type { MfaAccountLifecycleService } from "../domains/security/mfa/accountLifecycle.ts";
import type { MfaLoginLifecycleService } from "../domains/security/mfa/loginLifecycle.ts";
import type { SecurityAuditLifecycleService } from "../domains/security/securityAuditLifecycle.ts";
import type {
    ApplicationRuntime,
    ApplicationRuntimeServices,
} from "../platform/runtime/applicationRuntime.ts";
import {
    type PendingLoginCredential,
    type RawAuthenticationCredential,
} from "../rawHttp/authenticationCredentials.ts";

/** Parsed-credential authenticator supplied by the security composition root. */
export type AuthenticateCredential = (credential: RawAuthenticationCredential) => unknown;

/** Dependencies supplied while constructing one application request context. */
export interface RequestContextOptions {
    readonly applicationRuntime: ApplicationRuntime;
    readonly authenticationCredential: RawAuthenticationCredential;
    readonly authenticationClientSourceId: string;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly authenticateCredential: AuthenticateCredential;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly pendingLoginCredential: PendingLoginCredential;
    readonly request: Request;
    readonly requestId: string;
    readonly responseHeaders: Headers;
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
}

/** Dependencies supplied to every application tRPC procedure. */
export interface RequestContext {
    readonly authentication: RequestAuthentication;
    readonly authenticationClientSourceId: string;
    readonly authenticationLifecycle: AuthenticationLifecycleService;
    readonly automationSecurityLifecycle: AutomationSecurityLifecycleService;
    readonly authenticationLease?: AuthenticationLease;
    readonly mfaAccountLifecycle: MfaAccountLifecycleService;
    readonly mfaLoginLifecycle: MfaLoginLifecycleService;
    readonly pendingLoginCredential: PendingLoginCredential;
    readonly requestId: string;
    readonly responseHeaders: Headers;
    readonly securityAuditLifecycle: SecurityAuditLifecycleService;
    readonly services: ApplicationRuntimeServices;
    readonly userAgent?: string;
}

/**
 * Builds request-scoped tRPC context from explicitly injected runtime and auth services.
 * @param options Request and process-owned dependencies.
 * @returns Validated immutable request context.
 */
export async function createRequestContext(
    options: RequestContextOptions
): Promise<RequestContext> {
    const resolution = parseAuthenticationResolution(
        await options.authenticateCredential(options.authenticationCredential)
    );
    const userAgent = options.request.headers.get("user-agent");
    return Object.freeze({
        authentication: resolution.authentication,
        authenticationClientSourceId: options.authenticationClientSourceId,
        authenticationLifecycle: options.authenticationLifecycle,
        automationSecurityLifecycle: options.automationSecurityLifecycle,
        mfaAccountLifecycle: options.mfaAccountLifecycle,
        mfaLoginLifecycle: options.mfaLoginLifecycle,
        ...(resolution.lease && { authenticationLease: resolution.lease }),
        pendingLoginCredential: options.pendingLoginCredential,
        requestId: options.requestId,
        responseHeaders: options.responseHeaders,
        securityAuditLifecycle: options.securityAuditLifecycle,
        services: options.applicationRuntime.services,
        ...(userAgent !== null && { userAgent }),
    });
}
