import { hoursToMilliseconds, minutesToMilliseconds } from "date-fns";

/** Absolute lifetime shared by session persistence and cookie delivery. */
export const browserSessionAbsoluteDurationMs = hoursToMilliseconds(24 * 30);

/** Idle lifetime applied consistently by request authentication and lifecycle APIs. */
export const browserSessionIdleDurationDefaultMs = minutesToMilliseconds(30);
export const browserSessionIdleDurationMinimumMs = minutesToMilliseconds(5);
export const browserSessionIdleDurationMaximumMs = hoursToMilliseconds(24);

/**
 * Parses the shared browser-session idle policy at a composition boundary.
 * @param value Optional override in milliseconds.
 * @returns The validated override or the process default.
 */
export function parseBrowserSessionIdleDurationMs(value?: number): number {
    const durationMs = value ?? browserSessionIdleDurationDefaultMs;
    if (
        !Number.isSafeInteger(durationMs) ||
        durationMs < browserSessionIdleDurationMinimumMs ||
        durationMs > browserSessionIdleDurationMaximumMs
    ) {
        throw new RangeError("Session idle duration is invalid");
    }
    return durationMs;
}
