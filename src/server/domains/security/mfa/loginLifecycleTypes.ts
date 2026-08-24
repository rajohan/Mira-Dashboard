import type {
    AuthSessionSummary,
    AuthUser,
    PendingLoginSummary,
    RecoveryLoginInput,
    TotpLoginInput,
} from "../../../../contracts/auth.ts";
import type {
    GeneratedOpaqueToken,
    ParsedOpaqueToken,
} from "../../../shared/opaqueToken.ts";
import type {
    AuthenticatedBrowserIdentity,
    AuthenticationRequestMetadata,
} from "../authenticationSession.ts";
import type { AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import type { AuthenticationWorkGate } from "../authenticationWorkGate.ts";
import type {
    MfaLifecycleRepository,
    MfaUserRecord,
} from "./lifecycleRepositoryTypes.ts";
import type { TotpSecretCipher } from "./totpSecretCipher.ts";

export interface BeginPendingLoginInput {
    readonly clearedPasswordRateLimitBucketKey?: string;
    readonly currentIdentity?: AuthenticatedBrowserIdentity;
    readonly metadata: AuthenticationRequestMetadata;
    readonly userSnapshot: MfaUserRecord;
    readonly verifiedAt: Date;
}

export type BeginPendingLoginResult =
    | {
          readonly pendingLogin: PendingLoginSummary;
          readonly status: "created";
          readonly token: string;
      }
    | { readonly status: "identity-changed" }
    | { readonly status: "mfa-unavailable" };

interface IssuedMfaSession {
    readonly session: AuthSessionSummary;
    readonly token: string;
    readonly user: AuthUser;
}

export type CompleteMfaLoginResult =
    | ({ readonly status: "authenticated" } & IssuedMfaSession)
    | { readonly status: "invalid-proof" }
    | { readonly retryAfterSeconds: number; readonly status: "rate-limited" }
    | { readonly status: "service-unavailable" }
    | { readonly status: "state-changed" };

export interface MfaLoginLifecycleService {
    beginPendingLogin(input: BeginPendingLoginInput): BeginPendingLoginResult;
    completeRecoveryLogin(
        credential: ParsedOpaqueToken,
        input: RecoveryLoginInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<CompleteMfaLoginResult>;
    completeTotpLogin(
        credential: ParsedOpaqueToken,
        input: TotpLoginInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<CompleteMfaLoginResult>;
    pendingLoginSummary(credential: ParsedOpaqueToken): PendingLoginSummary | undefined;
    revokePendingLogin(
        credential: ParsedOpaqueToken,
        metadata: AuthenticationRequestMetadata
    ): boolean;
}

export interface MfaLoginLifecycleDependencies {
    readonly generateId?: () => string;
    readonly generatePendingLoginToken?: () => GeneratedOpaqueToken;
    readonly generateSessionToken?: () => GeneratedOpaqueToken;
    readonly now?: () => Date;
    readonly passwordWorkBudget: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly repository: MfaLifecycleRepository;
    readonly sessionIdleDurationMs?: number;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly totpWorkBudget: AuthenticationWorkBudget;
    readonly totpWorkGate: AuthenticationWorkGate;
    readonly verifyRecoveryCode?: (
        hashInput: string,
        validatorHash: string
    ) => Promise<boolean>;
}
