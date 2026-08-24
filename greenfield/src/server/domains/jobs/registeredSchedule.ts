import type { JobActionRegistration } from "./actionRegistry.ts";
import type { ScheduledJobInsert } from "./repository.ts";
import { nextScheduleOccurrence } from "./scheduleTime.ts";

/**
 * Builds the durable row for one code-owned action registration.
 * @param registration Reviewed action metadata and default cadence.
 * @param at Registration timestamp and next-occurrence boundary.
 * @returns The complete row, or undefined when no occurrence is representable.
 */
export function buildRegisteredSchedule(
    registration: JobActionRegistration,
    at: Date
): ScheduledJobInsert | undefined {
    const schedule = registration.defaultSchedule;
    const nextRunAtMs = nextScheduleOccurrence(schedule, at.getTime());
    if (nextRunAtMs === undefined) return undefined;

    return {
        actionKey: registration.actionKey,
        actionPayloadJson: JSON.stringify(registration.actionPayload),
        attemptLimit: registration.attemptLimit,
        cancellationPolicy: registration.cancellationPolicy,
        createdAt: at,
        cronExpression: schedule.kind === "cron" ? schedule.expression : null,
        description: registration.description,
        enabled: registration.defaultEnabled,
        id: registration.scheduleId,
        intervalMs: schedule.kind === "interval" ? schedule.intervalMs : null,
        name: registration.displayName,
        nextRunAt: new Date(nextRunAtMs),
        priority: registration.priority,
        resourceClass: registration.resourceClass,
        resourceKeysJson: JSON.stringify(registration.resourceKeys),
        retrySafe: registration.retrySafe,
        scheduleKind: schedule.kind,
        timeOfDay: schedule.kind === "daily" ? schedule.timeOfDay : null,
        timeZone: schedule.kind === "interval" ? null : schedule.timeZone,
        timeoutMs: registration.timeoutMs,
        updatedAt: at,
        version: 1,
    };
}
