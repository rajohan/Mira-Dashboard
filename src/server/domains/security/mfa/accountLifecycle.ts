import { createMfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import { createAccountFactorOperations } from "./accountLifecycleFactors.ts";
import type {
    MfaAccountLifecycleDependencies,
    MfaAccountLifecycleService,
} from "./accountLifecycleTypes.ts";
import { createAccountMfaDisableOperation } from "./accountMfaDisable.ts";
import { createAccountPasswordReauthenticationOperation } from "./accountPasswordReauthentication.ts";
import { createAccountRecoveryCodeRotationOperation } from "./accountRecoveryCodeRotation.ts";
import { createAccountRecoveryStepUpOperation } from "./accountRecoveryStepUp.ts";
import { createAccountSecuritySummaryOperation } from "./accountSecuritySummary.ts";
import { createAccountTotpStepUpOperation } from "./accountTotpStepUp.ts";
import { createAccountWebAuthnOperations } from "./accountWebAuthnOperations.ts";

export type {
    AccountSecuritySummaryResult,
    BeginTotpEnrollmentResult,
    BeginWebAuthnEnrollmentResult,
    BeginWebAuthnStepUpResult,
    ConfirmTotpEnrollmentResult,
    ConfirmWebAuthnEnrollmentResult,
    DisableMfaResult,
    MfaAccountLifecycleDependencies,
    MfaAccountLifecycleService,
    PasswordReauthenticationResult,
    RecoveryStepUpResult,
    RemoveTotpFactorResult,
    RemoveWebAuthnCredentialResult,
    RotateRecoveryCodesResult,
    TotpStepUpResult,
    WebAuthnStepUpResult,
} from "./accountLifecycleTypes.ts";

/**
 * Creates the account-side MFA coordinator above the synchronous SQLite unit of work.
 * Every proof, password, cipher, and recovery hash completes before a write transaction.
 * @returns Frozen account lifecycle service composed from focused operation groups.
 */
export function createMfaAccountLifecycleService(
    dependencies: MfaAccountLifecycleDependencies
): MfaAccountLifecycleService {
    const context = createMfaAccountLifecycleContext(dependencies);
    return Object.freeze({
        ...createAccountFactorOperations(context),
        ...createAccountMfaDisableOperation(context),
        ...createAccountPasswordReauthenticationOperation(context),
        ...createAccountRecoveryCodeRotationOperation(context),
        ...createAccountRecoveryStepUpOperation(context),
        ...createAccountSecuritySummaryOperation(context),
        ...createAccountTotpStepUpOperation(context),
        ...createAccountWebAuthnOperations(context),
    });
}
