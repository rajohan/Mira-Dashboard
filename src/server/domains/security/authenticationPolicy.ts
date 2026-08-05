import { hoursToMilliseconds, minutesToMilliseconds } from "date-fns";

/** Absolute lifetime shared by session persistence and cookie delivery. */
export const browserSessionAbsoluteDurationMs = hoursToMilliseconds(24 * 30);

/** Idle lifetime applied consistently by request authentication and lifecycle APIs. */
export const browserSessionIdleDurationDefaultMs = minutesToMilliseconds(30);
export const browserSessionIdleDurationMinimumMs = minutesToMilliseconds(5);
export const browserSessionIdleDurationMaximumMs = hoursToMilliseconds(24);
