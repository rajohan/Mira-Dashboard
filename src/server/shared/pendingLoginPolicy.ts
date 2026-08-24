import { minutesToMilliseconds } from "date-fns";

/** Absolute lifetime shared by pending-login persistence and cookie delivery. */
export const pendingLoginLifetimeMs = minutesToMilliseconds(5);
