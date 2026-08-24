import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import { createRemoveWebAuthnCredentialOperation } from "./accountWebAuthnCredentialRemoval.ts";
import { createBeginWebAuthnEnrollmentOperation } from "./accountWebAuthnEnrollmentBegin.ts";
import { createConfirmWebAuthnEnrollmentOperation } from "./accountWebAuthnEnrollmentConfirmation.ts";
import { createAccountWebAuthnStepUpOperation } from "./accountWebAuthnStepUp.ts";
import { createBeginWebAuthnStepUpOperation } from "./accountWebAuthnStepUpBegin.ts";

type AccountWebAuthnOperations = Pick<
    MfaAccountLifecycleService,
    | "beginWebAuthnEnrollment"
    | "beginWebAuthnStepUp"
    | "confirmWebAuthnEnrollment"
    | "removeWebAuthnCredential"
    | "stepUpWebAuthn"
>;

/**
 * Composes the five account-side WebAuthn ceremony and credential operations.
 * @returns The complete account-side WebAuthn operation set.
 */
export function createAccountWebAuthnOperations(
    context: MfaAccountLifecycleContext
): AccountWebAuthnOperations {
    return Object.freeze({
        ...createBeginWebAuthnEnrollmentOperation(context),
        ...createBeginWebAuthnStepUpOperation(context),
        ...createConfirmWebAuthnEnrollmentOperation(context),
        ...createRemoveWebAuthnCredentialOperation(context),
        ...createAccountWebAuthnStepUpOperation(context),
    });
}
