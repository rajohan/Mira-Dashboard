import * as v from "valibot";

import {
    type OpenClawCronJob,
    type UpdateOpenClawCronPatch,
    updateOpenClawCronPatchSchema,
} from "../../contracts/openClawCron.ts";
import { compareStrings } from "../../shared/validation.ts";

/** Fixed no-blind-retry guidance for an externally indeterminate mutation. */
export const openClawCronUnknownOutcomeMessage =
    "The OpenClaw cron outcome could not be confirmed. Refresh before retrying.";

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
            return `Every ${schedule.everyMs} ms`;
        }
        case "cron": {
            return `${schedule.expr}${schedule.tz === undefined ? "" : ` (${schedule.tz})`}`;
        }
        case "on-exit": {
            return "Process exit watcher (command redacted)";
        }
        case "stream": {
            return "Process stream watcher (command and match redacted)";
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
        wakeMode: job.wakeMode,
    };
}

export function openClawCronPatchJson(job: OpenClawCronJob): string {
    return JSON.stringify(editableOpenClawCronPatch(job), null, 2);
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
    const parsed = v.safeParse(updateOpenClawCronPatchSchema, decoded, {
        abortEarly: true,
    });
    if (!parsed.success) {
        return {
            message:
                "Only name, description, delivery, at/every/cron schedule, system-event or agent-turn payload, and wakeMode may be edited. Delivery must use the reviewed none, announce, or webhook patch fields.",
            success: false,
        };
    }
    const changed = v.safeParse(
        updateOpenClawCronPatchSchema,
        changedPatch(job, parsed.output),
        { abortEarly: true }
    );
    if (!changed.success) {
        return { message: "Change at least one reviewed field.", success: false };
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
            message:
                "Switching to webhook delivery requires a replacement write-only target.",
            success: false,
        };
    }
    return { patch: changed.output, success: true };
}
