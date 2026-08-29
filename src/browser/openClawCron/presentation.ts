import * as v from "valibot";

import {
    type OpenClawCronJob,
    type OpenClawCronRun,
    type UpdateOpenClawCronPatch,
    updateOpenClawCronPatchObjectSchema,
    updateOpenClawCronPatchSchema,
} from "../../contracts/openClawCron.ts";
import { compareStrings } from "../../shared/validation.ts";

/** Fixed no-blind-retry guidance for an externally indeterminate mutation. */
export const openClawCronUnknownOutcomeMessage =
    "Dashboard could not confirm whether OpenClaw completed the action. Refresh the current status before trying again.";

export function openClawCronSynchronizationLabel(
    state: OpenClawCronJob["synchronization"]["state"]
): string {
    if (state === "confirmed") return "In sync";
    if (state === "pending") return "Updating";
    return "Needs attention";
}

export function openClawCronRunStatusLabel(status: OpenClawCronRun["status"]): string {
    if (status === "ok") return "Succeeded";
    if (status === "error") return "Failed";
    if (status === "skipped") return "Skipped";
    return "Unknown";
}

/**
 * @param status Contract-validated OpenClaw run outcome.
 * @returns Shared badge treatment for one completed OpenClaw cron run.
 */
export function openClawCronRunStatusBadgeVariant(
    status: OpenClawCronRun["status"]
): "danger" | "default" | "success" {
    if (status === "ok") return "success";
    if (status === "error") return "danger";
    return "default";
}

/**
 * @param job Current contract-validated OpenClaw cron job.
 * @returns Compact operational state with running and disabled state taking precedence.
 */
export function openClawCronOperationalStatus(job: OpenClawCronJob): {
    readonly label: string;
    readonly variant: "danger" | "default" | "success" | "warning";
} {
    if (job.state.runningAtMs !== undefined) {
        return { label: "Running", variant: "warning" };
    }
    if (!job.enabled) return { label: "Disabled", variant: "default" };
    if (job.state.lastRunStatus === undefined) {
        return { label: "Scheduled", variant: "default" };
    }
    return {
        label: openClawCronRunStatusLabel(job.state.lastRunStatus),
        variant: openClawCronRunStatusBadgeVariant(job.state.lastRunStatus),
    };
}

export function openClawCronDeliveryStatusLabel(
    status: OpenClawCronRun["deliveryStatus"]
): string {
    if (status === "delivered") return "Delivered";
    if (status === "not-delivered") return "Not delivered";
    if (status === "not-requested") return "Not requested";
    return "Unknown";
}

export function openClawCronPayloadLabel(
    kind: OpenClawCronJob["payload"]["kind"]
): string {
    if (kind === "system-event") return "System event";
    if (kind === "agent-turn") return "Agent request";
    if (kind === "command") return "Command";
    if (kind === "script") return "Script";
    if (kind === "skill-collection-review") return "Skill collection review";
    return "Heartbeat";
}

export function openClawCronPayloadMessage(
    kind: OpenClawCronJob["payload"]["kind"]
): string | undefined {
    if (kind !== "skill-collection-review") return;
    return "Managed internally by OpenClaw; this workflow has no message or scratch payload.";
}

export function openClawCronDeliveryModeLabel(
    mode: OpenClawCronJob["deliveryMode"]
): string {
    if (mode === "announce") return "Announcement";
    if (mode === "none") return "None";
    if (mode === "webhook") return "Webhook";
    return "Not specified";
}

export function openClawCronSessionTargetLabel(
    target: OpenClawCronJob["sessionTarget"]
): string {
    if (target === "current") return "Current session";
    if (target === "isolated") return "Separate session";
    if (target === "main") return "Main session";
    return "Named session";
}

export function openClawCronWakeModeLabel(mode: OpenClawCronJob["wakeMode"]): string {
    return mode === "now" ? "Immediately" : "At the next check-in";
}

function repeatingScheduleLabel(milliseconds: number): string {
    const units = [
        [86_400_000, "day"],
        [3_600_000, "hour"],
        [60_000, "minute"],
        [1000, "second"],
    ] as const;
    for (const [unitMilliseconds, unit] of units) {
        if (milliseconds % unitMilliseconds !== 0) continue;
        const count = milliseconds / unitMilliseconds;
        return `Every ${count} ${unit}${count === 1 ? "" : "s"}`;
    }
    return `Every ${milliseconds} milliseconds`;
}

/**
 * @param jobs Bounded current Gateway cron page.
 * @returns Enabled jobs first, then stable name/id order within the bounded page.
 */
export function orderOpenClawCronJobs(
    jobs: readonly OpenClawCronJob[]
): OpenClawCronJob[] {
    return jobs.toSorted((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        const nameDifference = compareStrings(left.name, right.name);
        return nameDifference === 0 ? compareStrings(left.id, right.id) : nameDifference;
    });
}

export function openClawCronScheduleLabel(job: OpenClawCronJob): string {
    const schedule = job.schedule;
    switch (schedule.kind) {
        case "at": {
            return `Once at ${schedule.at}`;
        }
        case "every": {
            return repeatingScheduleLabel(schedule.everyMs);
        }
        case "cron": {
            return `${schedule.expr}${schedule.tz === undefined ? "" : ` (${schedule.tz})`}`;
        }
        case "on-exit": {
            return "Runs when a monitored process exits (command hidden)";
        }
        case "stream": {
            return "Runs when monitored process output matches (details hidden)";
        }
    }
}

function editablePayload(
    job: OpenClawCronJob
): UpdateOpenClawCronPatch["payload"] | undefined {
    if (job.payload.kind === "system-event") {
        if (job.payload.truncated) return;
        return { kind: job.payload.kind, text: job.payload.text };
    }
    if (job.payload.kind !== "agent-turn") return;
    if (job.payload.truncated) return;
    return {
        kind: job.payload.kind,
        ...(job.payload.lightContext === undefined
            ? {}
            : { lightContext: job.payload.lightContext }),
        message: job.payload.message,
        ...(job.payload.model === undefined ? {} : { model: job.payload.model }),
        ...(job.payload.thinking === undefined ? {} : { thinking: job.payload.thinking }),
        ...(job.payload.timeoutSeconds === undefined
            ? {}
            : { timeoutSeconds: job.payload.timeoutSeconds }),
    };
}

function editableSchedule(
    job: OpenClawCronJob
): UpdateOpenClawCronPatch["schedule"] | undefined {
    const schedule = job.schedule;
    if (schedule.kind === "at") {
        return schedule.truncated ? undefined : { at: schedule.at, kind: schedule.kind };
    }
    if (schedule.kind === "every") {
        return {
            ...(schedule.anchorMs === undefined ? {} : { anchorMs: schedule.anchorMs }),
            everyMs: schedule.everyMs,
            kind: schedule.kind,
        };
    }
    if (schedule.kind === "cron") {
        return schedule.truncated
            ? undefined
            : {
                  expr: schedule.expr,
                  kind: schedule.kind,
                  ...(schedule.staggerMs === undefined
                      ? {}
                      : { staggerMs: schedule.staggerMs }),
                  ...(schedule.tz === undefined ? {} : { tz: schedule.tz }),
              };
    }
    return;
}

export function editableOpenClawCronPatch(job: OpenClawCronJob): UpdateOpenClawCronPatch {
    const schedule = editableSchedule(job);
    const payload = editablePayload(job);
    return {
        ...(job.description === undefined || job.descriptionTruncated
            ? {}
            : { description: job.description }),
        ...(job.nameTruncated ? {} : { name: job.name }),
        ...(payload === undefined ? {} : { payload }),
        ...(schedule === undefined ? {} : { schedule }),
        ...(job.scratch === undefined || job.scratch.truncated
            ? {}
            : { scratch: job.scratch.content }),
        wakeMode: job.wakeMode,
    };
}

export function openClawCronPatchJson(job: OpenClawCronJob): string {
    const patch = editableOpenClawCronPatch(job);
    if (
        job.payload.kind === "heartbeat" &&
        job.scratch !== undefined &&
        !job.scratch.truncated
    ) {
        const { scratch, ...definition } = patch;
        void scratch;
        return JSON.stringify(
            {
                ...definition,
                payload: {
                    kind: "heartbeat",
                    message: job.scratch.content,
                },
            },
            null,
            2
        );
    }
    return JSON.stringify(patch, null, 2);
}

export type OpenClawCronPatchParseResult =
    | Readonly<{ patch: UpdateOpenClawCronPatch; success: true }>
    | Readonly<{ message: string; success: false }>;

const updatePatchFields = [
    "delivery",
    "description",
    "name",
    "payload",
    "schedule",
    "scratch",
    "wakeMode",
] as const satisfies readonly (keyof UpdateOpenClawCronPatch)[];

function changedPatch(
    job: OpenClawCronJob,
    candidate: UpdateOpenClawCronPatch
): Partial<UpdateOpenClawCronPatch> {
    const baseline = editableOpenClawCronPatch(job);
    const changed: Partial<UpdateOpenClawCronPatch> = {};
    for (const field of updatePatchFields) {
        const value = candidate[field];
        if (value === undefined) continue;
        if (
            Object.hasOwn(baseline, field) &&
            JSON.stringify(value) === JSON.stringify(baseline[field])
        ) {
            continue;
        }
        Object.assign(changed, { [field]: value });
    }
    return changed;
}

export function parseOpenClawCronPatchJson(
    value: string,
    job: OpenClawCronJob
): OpenClawCronPatchParseResult {
    let decoded: unknown;
    try {
        decoded = JSON.parse(value) as unknown;
    } catch {
        return { message: "Enter valid JSON.", success: false };
    }
    if (
        job.payload.kind === "heartbeat" &&
        typeof decoded === "object" &&
        decoded !== null &&
        !Array.isArray(decoded)
    ) {
        const candidate = decoded as Record<string, unknown>;
        const payload = candidate.payload;
        if (
            typeof payload === "object" &&
            payload !== null &&
            !Array.isArray(payload) &&
            Object.keys(payload).length === 2 &&
            (payload as Record<string, unknown>).kind === "heartbeat" &&
            typeof (payload as Record<string, unknown>).message === "string" &&
            candidate.scratch === undefined
        ) {
            const { payload: ignoredPayload, ...definition } = candidate;
            void ignoredPayload;
            decoded = {
                ...definition,
                scratch: (payload as Record<string, unknown>).message,
            };
        }
    }
    const parsed = v.safeParse(updateOpenClawCronPatchObjectSchema, decoded, {
        abortEarly: true,
    });
    if (!parsed.success) {
        return {
            message:
                "You can edit only name, description, delivery, schedule, payload, scratch, and wakeMode. Delivery supports none, announce, or webhook.",
            success: false,
        };
    }
    const changed = v.safeParse(
        updateOpenClawCronPatchSchema,
        changedPatch(job, parsed.output),
        { abortEarly: true }
    );
    if (!changed.success) {
        return { message: "Change at least one field.", success: false };
    }
    const delivery = changed.output.delivery;
    const effectiveDeliveryMode = delivery?.mode ?? job.delivery?.mode;
    const retainsConfiguredWebhookTarget =
        delivery?.to === undefined &&
        job.delivery?.mode === "webhook" &&
        job.delivery.targetConfigured;
    if (
        effectiveDeliveryMode === "webhook" &&
        typeof delivery?.to !== "string" &&
        !retainsConfiguredWebhookTarget
    ) {
        return {
            message: "Enter a new destination when switching to webhook delivery.",
            success: false,
        };
    }
    return { patch: changed.output, success: true };
}
