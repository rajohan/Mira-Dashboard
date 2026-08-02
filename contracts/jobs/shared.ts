import * as v from "valibot";

export const SCHEDULE_TYPES = ["interval", "daily", "cron"] as const;
export const JOB_EXECUTION_STATUSES = [
    "queued",
    "running",
    "success",
    "failed",
    "cancelled",
] as const;
export const JOB_EXECUTION_TRIGGER_TYPES = [
    "manual",
    "schedule",
    "startup",
    "system",
] as const;
export const JOB_RESOURCE_CLASSES = [
    "interactive",
    "light",
    "network",
    "host-heavy",
    "exclusive",
] as const;

export const jobResourceClassSchema = v.picklist(JOB_RESOURCE_CLASSES);
export const jobExecutionStatusSchema = v.picklist(JOB_EXECUTION_STATUSES);
export const jobExecutionTriggerTypeSchema = v.picklist(JOB_EXECUTION_TRIGGER_TYPES);
export const scheduledJobScheduleTypeSchema = v.picklist(SCHEDULE_TYPES);

export type JobResourceClass = v.InferOutput<typeof jobResourceClassSchema>;
export type JobExecutionStatus = v.InferOutput<typeof jobExecutionStatusSchema>;
export type JobExecutionTriggerType = v.InferOutput<typeof jobExecutionTriggerTypeSchema>;
export type ScheduledJobScheduleType = v.InferOutput<
    typeof scheduledJobScheduleTypeSchema
>;
