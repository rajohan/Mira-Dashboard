import type { ScheduledJob } from "../../../../contracts/jobs/scheduled.ts";
import type { ScheduledJobScheduleType } from "../../../../contracts/jobs/shared.ts";
import { ScheduledJobValidationError } from "./errors.ts";

const MINIMUM_INTERVAL_SECONDS = 60;

/** Validates the schedule-specific fields of a job definition. */
export function assertValidSchedule(
    scheduleType: ScheduledJobScheduleType,
    intervalSeconds: number,
    timeOfDay: string | undefined,
    cronExpression: string | undefined
): void {
    if (scheduleType === "interval") {
        if (
            !Number.isSafeInteger(intervalSeconds) ||
            intervalSeconds < MINIMUM_INTERVAL_SECONDS
        ) {
            throw new ScheduledJobValidationError(
                `Interval must be at least ${MINIMUM_INTERVAL_SECONDS} seconds`
            );
        }
        return;
    }
    if (scheduleType === "daily") {
        if (!timeOfDay || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(timeOfDay)) {
            throw new ScheduledJobValidationError("Daily jobs require HH:MM timeOfDay");
        }
        return;
    }
    if (!cronExpression || !parseCronExpression(cronExpression)) {
        throw new ScheduledJobValidationError("Cron jobs require a valid cronExpression");
    }
}

function parseCronField(
    field: string,
    minimum: number,
    maximum: number
): Set<number> | undefined {
    const values = new Set<number>();
    for (const part of field.split(",")) {
        if (!part) {
            return undefined;
        }
        const stepPieces = part.split("/");
        if (stepPieces.length > 2) {
            return undefined;
        }
        const [rangePart = "", stepPart] = stepPieces;
        const step = stepPart === undefined ? 1 : Number(stepPart);
        if (!Number.isSafeInteger(step) || step < 1) {
            return undefined;
        }
        const rangePieces = rangePart.split("-");
        if (rangePieces.length > 2) {
            return undefined;
        }
        let start: number;
        let end: number;
        if (rangePart === "*") {
            start = minimum;
            end = maximum;
        } else if (rangePart.includes("-")) {
            const [rawStart, rawEnd] = rangePieces;
            if (
                rawStart === undefined ||
                rawStart === "" ||
                rawEnd === undefined ||
                rawEnd === ""
            ) {
                return undefined;
            }
            start = Number(rawStart);
            end = Number(rawEnd);
        } else {
            if (rangePart === "") {
                return undefined;
            }
            start = Number(rangePart);
            end = stepPart === undefined ? Number(rangePart) : maximum;
        }
        if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            start < minimum ||
            end > maximum ||
            start > end
        ) {
            return undefined;
        }
        for (let value = start; value <= end; value += step) {
            values.add(value);
        }
    }
    return values;
}

function isCronFieldWildcard(
    values: Set<number>,
    minimum: number,
    maximum: number
): boolean {
    for (let value = minimum; value <= maximum; value += 1) {
        if (!values.has(value)) {
            return false;
        }
    }
    return true;
}

function parseCronExpression(expression: string):
    | undefined
    | {
          minutes: Set<number>;
          hours: Set<number>;
          daysOfMonth: Set<number>;
          months: Set<number>;
          daysOfWeek: Set<number>;
          dayOfMonthWildcard: boolean;
          dayOfWeekWildcard: boolean;
      } {
    const fields = expression.trim().split(/\s+/u);
    if (fields.length !== 5) {
        return undefined;
    }
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    if (
        minute === undefined ||
        hour === undefined ||
        dayOfMonth === undefined ||
        month === undefined ||
        dayOfWeek === undefined
    ) {
        return undefined;
    }
    const minutes = parseCronField(minute, 0, 59);
    const hours = parseCronField(hour, 0, 23);
    const daysOfMonth = parseCronField(dayOfMonth, 1, 31);
    const months = parseCronField(month, 1, 12);
    const daysOfWeek = parseCronField(dayOfWeek, 0, 7);
    if (!minutes || !hours || !daysOfMonth || !months || !daysOfWeek) {
        return undefined;
    }
    if (daysOfWeek.has(7)) {
        daysOfWeek.add(0);
        daysOfWeek.delete(7);
    }
    return {
        minutes,
        hours,
        daysOfMonth,
        months,
        daysOfWeek,
        dayOfMonthWildcard: isCronFieldWildcard(daysOfMonth, 1, 31),
        dayOfWeekWildcard: isCronFieldWildcard(daysOfWeek, 0, 6),
    };
}

function isCronDayMatch(
    cron: NonNullable<ReturnType<typeof parseCronExpression>>,
    day: Date
): boolean {
    const dayOfMonthMatches = cron.daysOfMonth.has(day.getUTCDate());
    const dayOfWeekMatches = cron.daysOfWeek.has(day.getUTCDay());
    if (!cron.dayOfMonthWildcard && !cron.dayOfWeekWildcard) {
        return dayOfMonthMatches || dayOfWeekMatches;
    }
    return dayOfMonthMatches && dayOfWeekMatches;
}

function nextCronRun(now: Date, expression: string): Date {
    const cron = parseCronExpression(expression);
    if (!cron) {
        throw new ScheduledJobValidationError("Cron jobs require a valid cronExpression");
    }
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCMinutes(next.getUTCMinutes() + 1);
    const maximumAttempts = 5 * 366 * 24 * 60;
    for (let index = 0; index < maximumAttempts; index += 1) {
        if (
            cron.minutes.has(next.getUTCMinutes()) &&
            cron.hours.has(next.getUTCHours()) &&
            cron.months.has(next.getUTCMonth() + 1) &&
            isCronDayMatch(cron, next)
        ) {
            return next;
        }
        next.setUTCMinutes(next.getUTCMinutes() + 1);
    }
    throw new ScheduledJobValidationError("Cron expression has no upcoming run");
}

function nextDailyRun(now: Date, timeOfDay: string): Date {
    const [hour = "0", minute = "0"] = timeOfDay.split(":", 2);
    const next = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate(),
            Number(hour),
            Number(minute),
            0,
            0
        )
    );
    if (next.getTime() <= now.getTime()) {
        next.setUTCDate(next.getUTCDate() + 1);
    }
    return next;
}

/**
 * Calculates the next run timestamp for one enabled schedule.
 * @param job Schedule definition to evaluate.
 * @param from Timestamp from which to calculate the next run.
 * @returns Next run timestamp, or undefined when the schedule is disabled.
 */
export function calculateNextRunAt(
    job: Pick<
        ScheduledJob,
        "enabled" | "intervalSeconds" | "scheduleType" | "timeOfDay"
    > &
        Pick<Partial<ScheduledJob>, "cronExpression">,
    from = new Date()
): string | undefined {
    if (!job.enabled) {
        return undefined;
    }
    if (job.scheduleType === "daily" && job.timeOfDay) {
        return nextDailyRun(from, job.timeOfDay).toISOString();
    }
    if (job.scheduleType === "cron" && job.cronExpression) {
        return nextCronRun(from, job.cronExpression).toISOString();
    }
    return new Date(from.getTime() + job.intervalSeconds * 1000).toISOString();
}
