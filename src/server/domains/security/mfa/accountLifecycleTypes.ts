import type {
    AccountSecuritySummary,
    BeginTotpEnrollmentInput,
    ConfirmTotpEnrollmentInput,
    DisableMfaInput,
    PasswordReauthenticationInput,
    RecoveryStepUpInput,
    RemoveTotpFactorInput,
    TotpEnrollment,
    TotpFactorSummary,
    TotpStepUpInput,
} from "../../../../contracts/accountSecurity.ts";
import type { AuthSessionSummary } from "../../../../contracts/auth.ts";
import type { GeneratedOpaqueToken } from "../../../shared/opaqueToken.ts";
import type {
    AuthenticationRequestMetadata,
    AuthenticatedBrowserIdentity,
} from "../authenticationSession.ts";
import type { AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import type { AuthenticationWorkGate } from "../authenticationWorkGate.ts";
import type { MfaLifecycleRepository } from "./lifecycleRepositoryTypes.ts";
import type { GeneratedRecoveryCode } from "./recoveryCodes.ts";
import type { TotpVerificationResult, VerifyDashboardTotpInput } from "./totp.ts";
import type { TotpSecretCipher } from "./totpSecretCipher.ts";

export type RateLimitedResult = {
    readonly retryAfterSeconds: number;
    readonly status: "rate-limited";
};
export type SessionChangedResult = { readonly status: "session-changed" };
export type StateChangedResult = { readonly status: "state-changed" };
export type StepUpRequiredResult = { readonly status: "step-up-required" };
export type EnrollmentRequiredResult = {
    readonly status: "mfa-enrollment-required";
};

export type BeginTotpEnrollmentResult =
    | { readonly enrollment: TotpEnrollment; readonly status: "created" }
    | { readonly status: "factor-limit" }
    | { readonly status: "service-unavailable" }
    | SessionChangedResult
    | StateChangedResult
    | StepUpRequiredResult;

export type ConfirmTotpEnrollmentResult =
    | {
          readonly enabledNow: false;
          readonly factor: TotpFactorSummary;
          readonly status: "confirmed";
      }
    | {
          readonly enabledNow: true;
          readonly factor: TotpFactorSummary;
          readonly recoveryCodes: readonly string[];
          readonly revokedSessions: number;
          readonly session: AuthSessionSummary;
          readonly status: "confirmed";
          readonly token: string;
      }
    | { readonly status: "factor-limit" }
    | { readonly status: "invalid-proof" }
    | RateLimitedResult
    | { readonly status: "service-unavailable" }
    | SessionChangedResult
    | StateChangedResult
    | StepUpRequiredResult;

export type DisableMfaResult =
    | {
          readonly disabled: true;
          readonly revokedSessions: number;
          readonly session: AuthSessionSummary;
          readonly status: "disabled";
          readonly token: string;
      }
    | { readonly status: "invalid-password" }
    | EnrollmentRequiredResult
    | RateLimitedResult
    | SessionChangedResult
    | StateChangedResult
    | StepUpRequiredResult;

export type PasswordReauthenticationResult =
    | {
          readonly session: AuthSessionSummary;
          readonly status: "verified";
          readonly token: string;
          readonly verifiedAtMs: number;
      }
    | { readonly status: "invalid-password" }
    | RateLimitedResult
    | SessionChangedResult;

export type RemoveTotpFactorResult =
    | {
          readonly factorId: string;
          readonly removed: true;
          readonly status: "removed";
      }
    | { readonly status: "final-factor" }
    | EnrollmentRequiredResult
    | { readonly status: "not-found" }
    | SessionChangedResult
    | StepUpRequiredResult;

export type RotateRecoveryCodesResult =
    | { readonly recoveryCodes: readonly string[]; readonly status: "rotated" }
    | EnrollmentRequiredResult
    | RateLimitedResult
    | SessionChangedResult
    | StateChangedResult
    | StepUpRequiredResult;

export type RecoveryStepUpResult =
    | {
          readonly method: "recovery";
          readonly recoveryCodesRemaining: number;
          readonly session: AuthSessionSummary;
          readonly status: "verified";
          readonly token: string;
          readonly verifiedAtMs: number;
      }
    | { readonly status: "invalid-proof" }
    | EnrollmentRequiredResult
    | RateLimitedResult
    | SessionChangedResult
    | StateChangedResult;

export type TotpStepUpResult =
    | {
          readonly method: "totp";
          readonly session: AuthSessionSummary;
          readonly status: "verified";
          readonly token: string;
          readonly verifiedAtMs: number;
      }
    | { readonly status: "invalid-proof" }
    | EnrollmentRequiredResult
    | RateLimitedResult
    | { readonly status: "service-unavailable" }
    | SessionChangedResult
    | StateChangedResult;

export type AccountSecuritySummaryResult =
    | { readonly status: "found"; readonly summary: AccountSecuritySummary }
    | SessionChangedResult;

export interface MfaAccountLifecycleService {
    beginTotpEnrollment(
        identity: AuthenticatedBrowserIdentity,
        input: BeginTotpEnrollmentInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<BeginTotpEnrollmentResult>;
    confirmTotpEnrollment(
        identity: AuthenticatedBrowserIdentity,
        input: ConfirmTotpEnrollmentInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<ConfirmTotpEnrollmentResult>;
    disableMfa(
        identity: AuthenticatedBrowserIdentity,
        input: DisableMfaInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<DisableMfaResult>;
    reauthenticatePassword(
        identity: AuthenticatedBrowserIdentity,
        input: PasswordReauthenticationInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<PasswordReauthenticationResult>;
    removeTotpFactor(
        identity: AuthenticatedBrowserIdentity,
        input: RemoveTotpFactorInput,
        metadata: AuthenticationRequestMetadata
    ): RemoveTotpFactorResult;
    rotateRecoveryCodes(
        identity: AuthenticatedBrowserIdentity,
        metadata: AuthenticationRequestMetadata
    ): Promise<RotateRecoveryCodesResult>;
    stepUpRecovery(
        identity: AuthenticatedBrowserIdentity,
        input: RecoveryStepUpInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<RecoveryStepUpResult>;
    stepUpTotp(
        identity: AuthenticatedBrowserIdentity,
        input: TotpStepUpInput,
        metadata: AuthenticationRequestMetadata
    ): Promise<TotpStepUpResult>;
    summary(identity: AuthenticatedBrowserIdentity): AccountSecuritySummaryResult;
}

export interface MfaAccountLifecycleDependencies {
    readonly generateId?: () => string;
    readonly generateRecoveryCodes?: (userId: string) => readonly GeneratedRecoveryCode[];
    readonly generateSessionToken?: () => GeneratedOpaqueToken;
    readonly generateTotpSecret?: () => string;
    readonly hashRecoveryCode?: (hashInput: string) => Promise<string>;
    readonly now?: () => Date;
    readonly passwordWorkBudget: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly recentAuthenticationWindowMs?: number;
    readonly repository: MfaLifecycleRepository;
    readonly sessionIdleDurationMs?: number;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly totpWorkBudget: AuthenticationWorkBudget;
    readonly totpWorkGate: AuthenticationWorkGate;
    readonly verifyPassword?: (password: string, hash: string) => Promise<boolean>;
    readonly verifyRecoveryCode?: (
        hashInput: string,
        validatorHash: string
    ) => Promise<boolean>;
    readonly verifyTotp?: (
        input: VerifyDashboardTotpInput
    ) => Promise<TotpVerificationResult | undefined>;
}
