import * as v from "valibot";

import {
    type ScheduleConfiguration,
    type ScheduleSummary,
    scheduleConfigurationSchema,
    scheduleCronExpressionSchema,
    scheduleIntervalMaximumMilliseconds,
    scheduleIntervalMinimumMilliseconds,
    scheduleKinds,
    scheduleTimeOfDaySchema,
    scheduleTimeZoneSchema,
} from "../../contracts/jobModel.ts";

const editorTextSchema = v.pipe(
    v.string("Schedule value is invalid"),
    v.maxLength(400, "Schedule value is outside its budget")
);

const scheduleEditorObjectSchema = v.strictObject({
    cronExpression: editorTextSchema,
    intervalSeconds: editorTextSchema,
    kind: v.picklist(scheduleKinds, "Schedule kind is invalid"),
    timeOfDay: editorTextSchema,
    timeZone: editorTextSchema,
});

function intervalMilliseconds(value: string): number | undefined {
    const normalized = value.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,3})?$/u.test(normalized)) return;
    const milliseconds = Number(normalized) * 1000;
    if (!Number.isSafeInteger(milliseconds)) return;
    if (
        milliseconds < scheduleIntervalMinimumMilliseconds ||
        milliseconds > scheduleIntervalMaximumMilliseconds
    ) {
        return;
    }
    return milliseconds;
}

/** Browser schedule values with validation conditional on the selected variant. */
export const scheduleEditorFormSchema = v.pipe(
    scheduleEditorObjectSchema,
    v.forward(
        v.check(
            (value) =>
                value.kind !== "interval" ||
                intervalMilliseconds(value.intervalSeconds) !== undefined,
            "Use an interval from 60 to 31,536,000 seconds"
        ),
        ["intervalSeconds"]
    ),
    v.forward(
        v.check(
            (value) =>
                value.kind !== "cron" ||
                v.safeParse(scheduleCronExpressionSchema, value.cronExpression).success,
            "Use a valid five-field cron expression"
        ),
        ["cronExpression"]
    ),
    v.forward(
        v.check(
            (value) =>
                value.kind !== "daily" ||
                v.safeParse(scheduleTimeOfDaySchema, value.timeOfDay).success,
            "Use a canonical 24-hour time"
        ),
        ["timeOfDay"]
    ),
    v.forward(
        v.check(
            (value) =>
                value.kind === "interval" ||
                v.safeParse(scheduleTimeZoneSchema, value.timeZone).success,
            "Use UTC or a canonical IANA time zone"
        ),
        ["timeZone"]
    )
);

export type ScheduleEditorValues = v.InferOutput<typeof scheduleEditorFormSchema>;

/** @returns Stable editor values that preserve inactive variant drafts. */
export function scheduleEditorValues(schedule: ScheduleSummary): ScheduleEditorValues {
    return {
        cronExpression:
            schedule.schedule.kind === "cron"
                ? schedule.schedule.expression
                : "0 * * * *",
        intervalSeconds:
            schedule.schedule.kind === "interval"
                ? String(schedule.schedule.intervalMs / 1000)
                : "60",
        kind: schedule.schedule.kind,
        timeOfDay:
            schedule.schedule.kind === "daily" ? schedule.schedule.timeOfDay : "00:00",
        timeZone:
            schedule.schedule.kind === "interval" ? "UTC" : schedule.schedule.timeZone,
    };
}

/** @returns One validated, mutually exclusive schedule configuration. */
export function scheduleConfigurationFromEditor(
    values: ScheduleEditorValues
): ScheduleConfiguration {
    switch (values.kind) {
        case "cron": {
            return v.parse(scheduleConfigurationSchema, {
                expression: values.cronExpression,
                kind: values.kind,
                timeZone: values.timeZone,
            });
        }
        case "daily": {
            return v.parse(scheduleConfigurationSchema, {
                kind: values.kind,
                timeOfDay: values.timeOfDay,
                timeZone: values.timeZone,
            });
        }
        case "interval": {
            return v.parse(scheduleConfigurationSchema, {
                intervalMs: intervalMilliseconds(values.intervalSeconds),
                kind: values.kind,
            });
        }
    }
}
