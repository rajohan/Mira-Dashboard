import type { MfaAccountLifecycleContext } from "./accountLifecycleContext.ts";
import type { MfaAccountLifecycleService } from "./accountLifecycleTypes.ts";
import { createBeginTotpEnrollmentOperation } from "./accountTotpEnrollmentBegin.ts";
import { createConfirmTotpEnrollmentOperation } from "./accountTotpEnrollmentConfirmation.ts";
import { createRemoveTotpFactorOperation } from "./accountTotpFactorRemoval.ts";

type EnrollmentOperations = Pick<
    MfaAccountLifecycleService,
    "beginTotpEnrollment" | "confirmTotpEnrollment" | "removeTotpFactor"
>;

/**
 * Composes the operation-focused TOTP enrollment and factor lifecycle.
 * @returns Frozen enrollment and factor-operation group.
 */
export function createAccountFactorOperations(
    context: MfaAccountLifecycleContext
): EnrollmentOperations {
    return Object.freeze({
        ...createBeginTotpEnrollmentOperation(context),
        ...createConfirmTotpEnrollmentOperation(context),
        ...createRemoveTotpFactorOperation(context),
    });
}
