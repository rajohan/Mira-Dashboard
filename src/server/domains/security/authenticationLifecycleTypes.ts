import type {
    AuthSessionSummary,
    AuthUser,
    FirstUserBootstrapInput,
    PasswordChangeInput,
    PasswordLoginInput,
    PendingLoginSummary,
} from "../../../contracts/auth.ts";
import type { GeneratedOpaqueToken } from "../../shared/opaqueToken.ts";
import type { AuthenticationLifecycleRepository } from "./authenticationLifecycleRepository.ts";
import type {
    AuthenticatedBrowserIdentity,
    AuthenticationRequestMetadata,
} from "./authenticationSession.ts";
import type { AuthenticationWorkBudget } from "./authenticationWorkBudget.ts";
import type {
    AuthenticationWorkGate,
    AuthenticationWorkRuntimeService,
} from "./authenticationWorkGate.ts";
import type {
    BeginPendingLoginInput,
    BeginPendingLoginResult,
} from "./mfa/loginLifecycle.ts";

export type VerifyGatewayCredential = (
    credential: string,
    signal?: AbortSignal
) => Promise<boolean>;

export interface PendingLoginLifecyclePort {
    beginPendingLogin(input: BeginPendingLoginInput): Promise<BeginPendingLoginResult>;
}

export interface AuthenticationLifecycleDependencies {
    readonly generateId?: () => string;
    readonly generateSessionToken?: () => GeneratedOpaqueToken;
    readonly gatewayVerificationTimeoutMs?: number;
    readonly gatewayWorkRuntime: Pick<
        AuthenticationWorkRuntimeService,
        "runGatewayVerification"
    >;
    readonly hashPassword?: (password: string) => Promise<string>;
    readonly mfaLoginLifecycle: PendingLoginLifecyclePort;
    readonly now?: () => Date;
    readonly passwordWorkBudget?: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly recentAuthenticationWindowMs?: number;
    readonly repository: AuthenticationLifecycleRepository;
    readonly sessionIdleDurationMs?: number;
    readonly verifyGatewayCredential: VerifyGatewayCredential;
    readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
}

export interface IssuedSessionResult {
    readonly session: AuthSessionSummary;
    readonly token: string;
    readonly user: AuthUser;
}

export type BootstrapResult =
    | ({ readonly status: "created" } & IssuedSessionResult)
    | { readonly status: "closed" }
    | { readonly status: "gateway-unavailable" }
    | { readonly status: "invalid-gateway" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" };

export type LoginResult =
    | ({ readonly status: "created" } & IssuedSessionResult)
    | {
          readonly pendingLogin: PendingLoginSummary;
          readonly status: "mfa-required";
          readonly token: string;
      }
    | { readonly status: "bootstrap-required" }
    | { readonly status: "invalid-credentials" }
    | { readonly status: "service-unavailable" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" };

export type ChangePasswordResult =
    | ({
          readonly revokedSessions: number;
          readonly status: "changed";
      } & IssuedSessionResult)
    | { readonly status: "invalid-current-password" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" }
    | { readonly status: "same-password" }
    | { readonly status: "session-changed" }
    | { readonly status: "step-up-required" };

export type RevokeSessionResult =
    | { readonly revoked: boolean }
    | { readonly status: "step-up-required" };

export type RevokeSessionsResult =
    | { readonly revokedSessions: number }
    | { readonly status: "step-up-required" };

export type AuthenticationStatus =
    | { readonly authenticated: false; readonly isBootstrapRequired: boolean }
    | {
          readonly authenticated: true;
          readonly isBootstrapRequired: false;
          readonly session: AuthSessionSummary;
          readonly user: AuthUser;
      };

/** Session-bound authorization result for controls that require recently verified MFA. */
export type RecentMfaAuthorization =
    | "authorized"
    | "mfa-enrollment-required"
    | "session-changed"
    | "step-up-required";

export interface AuthenticationLifecycleService {
    authorizeRecentMfa(identity: AuthenticatedBrowserIdentity): RecentMfaAuthorization;
    bootstrap(
        input: FirstUserBootstrapInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<BootstrapResult>;
    changePassword(
        identity: AuthenticatedBrowserIdentity,
        input: PasswordChangeInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<ChangePasswordResult>;
    listSessions(
        identity: AuthenticatedBrowserIdentity
    ): AuthSessionSummary[] | undefined;
    login(
        input: PasswordLoginInput,
        metadata: AuthenticationRequestMetadata,
        currentIdentity?: AuthenticatedBrowserIdentity
    ): Promise<LoginResult>;
    logout(
        identity: AuthenticatedBrowserIdentity | undefined,
        metadata: AuthenticationRequestMetadata
    ): Promise<boolean>;
    revokeSession(
        identity: AuthenticatedBrowserIdentity,
        sessionId: string,
        metadata: AuthenticationRequestMetadata
    ): Promise<RevokeSessionResult | undefined>;
    revokeAllSessions(
        identity: AuthenticatedBrowserIdentity,
        metadata: AuthenticationRequestMetadata
    ): Promise<RevokeSessionsResult | undefined>;
    revokeOtherSessions(
        identity: AuthenticatedBrowserIdentity,
        metadata: AuthenticationRequestMetadata
    ): Promise<RevokeSessionsResult | undefined>;
    status(identity?: AuthenticatedBrowserIdentity): AuthenticationStatus;
    touchSession(
        identity: AuthenticatedBrowserIdentity
    ): Promise<{ readonly lastSeenAtMs: number } | undefined>;
}
