import { Cron, Result } from "effect";
import * as v from "valibot";

import {
    type ScheduleConfiguration,
    jobTimestampSchema,
    scheduleConfigurationSchema,
} from "../../../contracts/jobModel.ts";

function parseSchedule(schedule: ScheduleConfiguration): ScheduleConfiguration {
    return v.parse(scheduleConfigurationSchema, schedule);
}

function nextCronOccurrence(
    expression: string,
    timeZone: string,
    afterMs: number
): number | undefined {
    const parsed = Cron.parse(expression, timeZone);
    if (Result.isFailure(parsed)) return undefined;
    try {
        const next = Cron.next(parsed.success, new Date(afterMs)).getTime();
        return next > afterMs && v.safeParse(jobTimestampSchema, next).success
            ? next
            : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Computes the first occurrence strictly after a durable timestamp.
 * @param schedule Canonical schedule variant.
 * @param afterMs Exclusive lower bound.
 * @param intervalAnchorMs Original interval occurrence used to avoid cadence drift.
 * @returns The next valid occurrence, when one can be represented.
 */
export function nextScheduleOccurrence(
    schedule: ScheduleConfiguration,
    afterMs: number,
    intervalAnchorMs = afterMs
): number | undefined {
    const canonical = parseSchedule(schedule);
    v.parse(jobTimestampSchema, afterMs);
    v.parse(jobTimestampSchema, intervalAnchorMs);
    if (canonical.kind === "interval") {
        if (intervalAnchorMs > afterMs) return intervalAnchorMs;
        const elapsed = Math.max(0, afterMs - intervalAnchorMs);
        const steps = Math.floor(elapsed / canonical.intervalMs) + 1;
        const next = intervalAnchorMs + steps * canonical.intervalMs;
        return v.safeParse(jobTimestampSchema, next).success ? next : undefined;
    }
    if (canonical.kind === "daily") {
        const [hourText, minuteText] = canonical.timeOfDay.split(":");
        const hour = Number(hourText);
        const minute = Number(minuteText);
        return nextCronOccurrence(`${minute} ${hour} * * *`, canonical.timeZone, afterMs);
    }
    return nextCronOccurrence(canonical.expression, canonical.timeZone, afterMs);
}
