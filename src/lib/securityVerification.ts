export type SecurityVerificationCode =
    "mfa_enrollment_required" | "recent_verification_required" | "step_up_required";
export type SecurityVerificationOutcome = "cancelled" | "unclaimed" | "verified";

export const SECURITY_VERIFICATION_REQUIRED_EVENT_NAME =
    "mira:security-verification-required";
export const SECURITY_VERIFICATION_COMPLETED_EVENT_NAME =
    "mira:security-verification-completed";
export const SECURITY_VERIFICATION_CANCELLED_EVENT_NAME =
    "mira:security-verification-cancelled";
export const SECURITY_VERIFICATION_FLOW_TIMEOUT_MS = 10 * 60_000;

const SECURITY_VERIFICATION_CODES = new Set<SecurityVerificationCode>([
    "mfa_enrollment_required",
    "recent_verification_required",
    "step_up_required",
]);

/** Identifies an explicit dismissal of a claimed shared verification flow. */
export class SecurityVerificationCancelledError extends Error {
    readonly code: SecurityVerificationCode;

    constructor(code: SecurityVerificationCode) {
        super("Security verification cancelled");
        this.name = "SecurityVerificationCancelledError";
        this.code = code;
    }
}

export function isSecurityVerificationCode(
    value: unknown
): value is SecurityVerificationCode {
    return (
        typeof value === "string" &&
        SECURITY_VERIFICATION_CODES.has(value as SecurityVerificationCode)
    );
}

function wasSecurityVerificationClaimed(code: SecurityVerificationCode): boolean {
    const event = new CustomEvent(SECURITY_VERIFICATION_REQUIRED_EVENT_NAME, {
        cancelable: true,
        detail: { code },
    });
    dispatchEvent(event);
    return event.defaultPrevented;
}

export function dispatchSecurityVerificationRequired(
    code: SecurityVerificationCode
): void {
    wasSecurityVerificationClaimed(code);
}

/** Releases privileged requests after the shared verification flow succeeds. */
export function completeSecurityVerification(): void {
    dispatchEvent(new Event(SECURITY_VERIFICATION_COMPLETED_EVENT_NAME));
}

/** Releases privileged requests without retrying when verification is dismissed. */
export function cancelSecurityVerification(): void {
    dispatchEvent(new Event(SECURITY_VERIFICATION_CANCELLED_EVENT_NAME));
}

/**
 * Opens the shared verification flow and waits only when a mounted UI claims it.
 * Callers can then retry the exact request that the server rejected before mutation.
 */
export function waitForSecurityVerificationOutcome(
    code: SecurityVerificationCode,
    timeoutMs = SECURITY_VERIFICATION_FLOW_TIMEOUT_MS
): Promise<SecurityVerificationOutcome> {
    return new Promise((resolve) => {
        let isSettled = false;
        const timeoutReference: {
            current?: ReturnType<typeof setTimeout>;
        } = {};
        const settle = (outcome: SecurityVerificationOutcome) => {
            if (isSettled) return;
            isSettled = true;
            if (timeoutReference.current !== undefined) {
                clearTimeout(timeoutReference.current);
            }
            removeEventListener(SECURITY_VERIFICATION_COMPLETED_EVENT_NAME, onCompleted);
            removeEventListener(SECURITY_VERIFICATION_CANCELLED_EVENT_NAME, onCancelled);
            resolve(outcome);
        };
        const onCompleted = () => settle("verified");
        const onCancelled = () => settle("cancelled");

        addEventListener(SECURITY_VERIFICATION_COMPLETED_EVENT_NAME, onCompleted, {
            once: true,
        });
        addEventListener(SECURITY_VERIFICATION_CANCELLED_EVENT_NAME, onCancelled, {
            once: true,
        });

        if (!wasSecurityVerificationClaimed(code)) {
            settle("unclaimed");
            return;
        }
        timeoutReference.current = setTimeout(() => settle("cancelled"), timeoutMs);
    });
}

export async function waitForSecurityVerification(
    code: SecurityVerificationCode,
    timeoutMs = SECURITY_VERIFICATION_FLOW_TIMEOUT_MS
): Promise<boolean> {
    return (await waitForSecurityVerificationOutcome(code, timeoutMs)) === "verified";
}
