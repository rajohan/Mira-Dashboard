import { hoursToMilliseconds } from "date-fns";

/** Default durable retention shared by application realtime producers. */
export const defaultRealtimeRetentionMilliseconds = hoursToMilliseconds(168);
