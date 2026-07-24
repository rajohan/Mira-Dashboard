export type SecurityVerificationCode =
    "mfa_enrollment_required" | "recent_verification_required" | "step_up_required";

const SECURITY_VERIFICATION_CODES = new Set<SecurityVerificationCode>([
    "mfa_enrollment_required",
    "recent_verification_required",
    "step_up_required",
]);

export function isSecurityVerificationCode(
    value: unknown
): value is SecurityVerificationCode {
    return (
        typeof value === "string" &&
        SECURITY_VERIFICATION_CODES.has(value as SecurityVerificationCode)
    );
}

export function dispatchSecurityVerificationRequired(
    code: SecurityVerificationCode
): void {
    dispatchEvent(
        new CustomEvent("mira:security-verification-required", {
            detail: { code },
        })
    );
}
