import type { AuthSession } from "./sessionTypes.ts";

const DEFAULT_SESSION_IDLE_MINUTES = 30;
const MINIMUM_SESSION_IDLE_MINUTES = 5;
const MAXIMUM_SESSION_IDLE_MINUTES = 24 * 60;
const DEFAULT_RECENT_AUTHENTICATION_MINUTES = 10;
const MINIMUM_RECENT_AUTHENTICATION_MINUTES = 1;
const MAXIMUM_RECENT_AUTHENTICATION_MINUTES = 60;

/**
 * Resolves the idle timeout while keeping unsafe environment values fail-closed.
 * @param configuredMinutes Configured minutes value.
 * @returns Resolved the idle timeout while keeping unsafe environment values fail-closed.
 */
export function sessionIdleTtlMs(
    configuredMinutes = process.env.MIRA_DASHBOARD_SESSION_IDLE_MINUTES
): number {
    const normalized = configuredMinutes?.trim();
    if (!normalized) {
        return DEFAULT_SESSION_IDLE_MINUTES * 60_000;
    }
    if (!/^\d+$/u.test(normalized)) {
        throw new TypeError("MIRA_DASHBOARD_SESSION_IDLE_MINUTES must be an integer");
    }
    const minutes = Number(normalized);
    if (
        !Number.isSafeInteger(minutes) ||
        minutes < MINIMUM_SESSION_IDLE_MINUTES ||
        minutes > MAXIMUM_SESSION_IDLE_MINUTES
    ) {
        throw new RangeError(
            `MIRA_DASHBOARD_SESSION_IDLE_MINUTES must be ${MINIMUM_SESSION_IDLE_MINUTES}-${MAXIMUM_SESSION_IDLE_MINUTES}`
        );
    }
    return minutes * 60_000;
}

/**
 * Resolves the bounded window used for privileged account-security actions.
 * @param configuredMinutes Configured minutes value.
 * @returns Resolved the bounded window used for privileged account-security actions.
 */
export function recentAuthenticationTtlMs(
    configuredMinutes = process.env.MIRA_DASHBOARD_RECENT_AUTH_MINUTES
): number {
    const normalized = configuredMinutes?.trim();
    if (!normalized) {
        return DEFAULT_RECENT_AUTHENTICATION_MINUTES * 60_000;
    }
    if (!/^\d+$/u.test(normalized)) {
        throw new TypeError("MIRA_DASHBOARD_RECENT_AUTH_MINUTES must be an integer");
    }
    const minutes = Number(normalized);
    if (
        !Number.isSafeInteger(minutes) ||
        minutes < MINIMUM_RECENT_AUTHENTICATION_MINUTES ||
        minutes > MAXIMUM_RECENT_AUTHENTICATION_MINUTES
    ) {
        throw new RangeError(
            `MIRA_DASHBOARD_RECENT_AUTH_MINUTES must be ${MINIMUM_RECENT_AUTHENTICATION_MINUTES}-${MAXIMUM_RECENT_AUTHENTICATION_MINUTES}`
        );
    }
    return minutes * 60_000;
}

/** Fails startup before serving requests when authentication timing config is unsafe. */
export function validateAuthenticationConfig(): void {
    sessionIdleTtlMs();
    recentAuthenticationTtlMs();
}

function isRecentTimestamp(
    timestamp: string | undefined,
    now: Date,
    ttlMs: number
): boolean {
    if (!timestamp) return false;
    const parsed = Date.parse(timestamp);
    const age = now.getTime() - parsed;
    return Number.isFinite(parsed) && age >= -60_000 && age <= ttlMs;
}

/**
 * Returns whether the current session has a recent password verification.
 * @returns Whether the current session has a recent password verification.
 */
export function hasRecentPasswordVerification(
    session: AuthSession,
    now = new Date()
): boolean {
    return (
        session.elevatedMethod === "password" &&
        isRecentTimestamp(session.elevatedAt, now, recentAuthenticationTtlMs())
    );
}

/**
 * Returns whether the current session has a recent second-factor verification.
 * @returns Whether the current session has a recent second-factor verification.
 */
export function hasRecentMfaVerification(
    session: AuthSession,
    now = new Date()
): boolean {
    return isRecentTimestamp(session.mfaVerifiedAt, now, recentAuthenticationTtlMs());
}
