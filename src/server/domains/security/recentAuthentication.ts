import { getTime, minutesToMilliseconds } from "date-fns";
import { maxTime } from "date-fns/constants";

export const recentAuthenticationWindowDefaultMs = minutesToMilliseconds(10);
export const recentAuthenticationWindowMinimumMs = minutesToMilliseconds(1);
export const recentAuthenticationWindowMaximumMs = minutesToMilliseconds(60);

/** Server-relative classification for one persisted authentication proof. */
export type RecentAuthenticationFreshness =
    | { readonly recent: false }
    | {
          readonly expiresAtMs: number;
          readonly recent: true;
          readonly remainingMs: number;
          readonly verifiedAtMs: number;
      };

export interface RecentAuthenticationInput {
    readonly checkedAt: Date;
    readonly mfaEnabledAt: Date | null;
    readonly mfaVerifiedAt: Date | null;
    readonly passwordVerifiedAt: Date;
    readonly windowMs?: number;
}

export interface RecentAuthenticationEvaluation {
    readonly mfa: RecentAuthenticationFreshness;
    readonly password: RecentAuthenticationFreshness;
}

const staleAuthentication = Object.freeze({ recent: false as const });

function persistedTimestamp(value: Date, label: string): number {
    const timestamp = getTime(value);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > maxTime) {
        throw new RangeError(`${label} timestamp is invalid`);
    }
    return timestamp;
}

function recentAuthenticationWindow(windowMs: number): number {
    if (
        !Number.isSafeInteger(windowMs) ||
        windowMs < recentAuthenticationWindowMinimumMs ||
        windowMs > recentAuthenticationWindowMaximumMs
    ) {
        throw new RangeError("Recent-auth window is invalid");
    }
    return windowMs;
}

function classifyFreshness(
    verifiedAtMs: number | undefined,
    checkedAtMs: number,
    windowMs: number,
    notBeforeMs?: number
): RecentAuthenticationFreshness {
    if (
        verifiedAtMs === undefined ||
        verifiedAtMs > checkedAtMs ||
        (notBeforeMs !== undefined && verifiedAtMs < notBeforeMs)
    ) {
        return staleAuthentication;
    }

    const expiresAtMs = verifiedAtMs + windowMs;
    if (
        !Number.isSafeInteger(expiresAtMs) ||
        expiresAtMs > maxTime ||
        expiresAtMs <= checkedAtMs
    ) {
        return staleAuthentication;
    }

    return Object.freeze({
        expiresAtMs,
        recent: true as const,
        remainingMs: expiresAtMs - checkedAtMs,
        verifiedAtMs,
    });
}

/**
 * Classifies recent password and MFA evidence for an MFA-enabled user.
 * General session activity never extends either fixed verification window.
 * @param input Server check time, MFA enablement, persisted proofs, and window.
 * @returns Frozen password and MFA freshness classifications.
 */
export function evaluateRecentAuthentication(
    input: RecentAuthenticationInput
): RecentAuthenticationEvaluation {
    const checkedAtMs = persistedTimestamp(input.checkedAt, "Recent-auth check");
    const mfaEnabledAtMs =
        input.mfaEnabledAt === null
            ? undefined
            : persistedTimestamp(input.mfaEnabledAt, "MFA enablement");
    const passwordVerifiedAtMs = persistedTimestamp(
        input.passwordVerifiedAt,
        "Password verification"
    );
    const mfaVerifiedAtMs =
        input.mfaVerifiedAt === null
            ? undefined
            : persistedTimestamp(input.mfaVerifiedAt, "MFA verification");
    const windowMs = recentAuthenticationWindow(
        input.windowMs ?? recentAuthenticationWindowDefaultMs
    );

    return Object.freeze({
        mfa: classifyFreshness(
            mfaEnabledAtMs === undefined ? undefined : mfaVerifiedAtMs,
            checkedAtMs,
            windowMs,
            mfaEnabledAtMs
        ),
        password: classifyFreshness(passwordVerifiedAtMs, checkedAtMs, windowMs),
    });
}
