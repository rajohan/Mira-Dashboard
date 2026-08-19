import * as v from "valibot";

import {
    type GetOpenClawCronResult,
    type ListOpenClawCronResult,
    type ListOpenClawCronRunsResult,
    type OpenClawCronDelivery,
    type OpenClawCronDeliveryProjection,
    type OpenClawCronFreshness,
    type OpenClawCronJob,
    type OpenClawCronLinkedTask,
    type OpenClawCronRun,
    getOpenClawCronResultSchema,
    listOpenClawCronResultSchema,
    listOpenClawCronRunsResultSchema,
    openClawCronAtScheduleIsValid,
    openClawCronConfigRevisionSchema,
    openClawCronDeliveryAccountIdMaximumLength,
    openClawCronDeliveryChannelMaximumLength,
    openClawCronDeliveryThreadIdMaximumLength,
    openClawCronFailureReasons,
    openClawCronJobIdSchema,
    openClawCronJobSchema,
    openClawCronPayloadTextMaximumLength,
    openClawCronRunSchema,
    openClawCronTimestampSchema,
} from "../../../contracts/openClawCron.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import type { OpenClawCronActiveDisableIntent } from "./intentStore.ts";
import {
    OpenClawCronProviderError,
    type OpenClawCronProviderJob,
    type OpenClawCronProviderListPage,
    type OpenClawCronProviderPayload,
    type OpenClawCronProviderRunEntry,
    type OpenClawCronProviderRunPage,
    type OpenClawCronProviderSchedule,
} from "./provider.ts";

function invalidProviderData(cause?: unknown): OpenClawCronProviderError {
    return new OpenClawCronProviderError("invalid-data", { cause });
}

function unicodeCodePoints(value: string): string[] {
    const codePoints: string[] = [];
    for (const codePoint of value) codePoints.push(codePoint);
    return codePoints;
}

function parseProviderProjection<TSchema extends v.GenericSchema>(
    schema: TSchema,
    value: unknown
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value, { abortEarly: true });
    if (!result.success) throw invalidProviderData(result.issues);
    return result.output;
}

function truncate(
    value: string,
    maximumCodePoints: number
): { text: string; truncated: boolean } {
    const safe = value.replaceAll("\0", "");
    const codePoints = unicodeCodePoints(safe);
    if (codePoints.length <= maximumCodePoints) {
        return { text: safe, truncated: safe !== value };
    }
    return { text: codePoints.slice(0, maximumCodePoints).join(""), truncated: true };
}

function safeLabelProjection(
    value: string,
    fallback: string,
    maximumCodePoints: number
): { text: string; truncated: boolean } {
    const visible = value.replaceAll(/[\p{Cc}\p{Cf}]/gu, " ").trim();
    const projected = truncate(visible || fallback, maximumCodePoints);
    return {
        text: projected.text,
        truncated: projected.truncated || projected.text !== value,
    };
}

function safeLabel(value: string, fallback: string, maximumCodePoints: number): string {
    return safeLabelProjection(value, fallback, maximumCodePoints).text;
}

function optionalText(
    value: string | undefined,
    maximumCodePoints: number
): { text?: string; truncated: boolean } {
    if (value === undefined) return { truncated: false };
    if (value.trim().length === 0) return { truncated: true };
    const projected = truncate(value, maximumCodePoints);
    return { text: projected.text, truncated: projected.truncated };
}

function projectDelivery(delivery: OpenClawCronDelivery): OpenClawCronDeliveryProjection {
    const failureDestination = delivery.failureDestination;
    const accountId =
        delivery.accountId === undefined
            ? undefined
            : safeLabelProjection(
                  delivery.accountId,
                  "unknown",
                  openClawCronDeliveryAccountIdMaximumLength
              );
    const channel =
        delivery.channel === undefined
            ? undefined
            : safeLabelProjection(
                  delivery.channel,
                  "unknown",
                  openClawCronDeliveryChannelMaximumLength
              );
    const failureAccountId =
        failureDestination?.accountId === undefined
            ? undefined
            : safeLabelProjection(
                  failureDestination.accountId,
                  "unknown",
                  openClawCronDeliveryAccountIdMaximumLength
              );
    const failureChannel =
        failureDestination?.channel === undefined
            ? undefined
            : safeLabelProjection(
                  failureDestination.channel,
                  "unknown",
                  openClawCronDeliveryChannelMaximumLength
              );
    const threadId =
        typeof delivery.threadId === "string"
            ? safeLabelProjection(
                  delivery.threadId,
                  "unknown",
                  openClawCronDeliveryThreadIdMaximumLength
              )
            : undefined;
    let projectedThreadId: number | string | undefined;
    if (typeof delivery.threadId === "number") {
        projectedThreadId = delivery.threadId;
    } else if (threadId?.truncated === false) {
        projectedThreadId = threadId.text;
    }
    return {
        ...(accountId === undefined || accountId.truncated
            ? {}
            : { accountId: accountId.text }),
        ...(delivery.bestEffort === undefined ? {} : { bestEffort: delivery.bestEffort }),
        ...(channel === undefined || channel.truncated ? {} : { channel: channel.text }),
        completionDestinationConfigured:
            "completionDestination" in delivery &&
            delivery.completionDestination !== undefined,
        ...(failureDestination === undefined
            ? {}
            : {
                  failureDestination: {
                      ...(failureAccountId === undefined || failureAccountId.truncated
                          ? {}
                          : { accountId: failureAccountId.text }),
                      ...(failureChannel === undefined || failureChannel.truncated
                          ? {}
                          : { channel: failureChannel.text }),
                      ...(failureDestination.mode === undefined
                          ? {}
                          : { mode: failureDestination.mode }),
                      targetConfigured: failureDestination.to !== undefined,
                  },
              }),
        metadataTruncated:
            accountId?.truncated === true ||
            channel?.truncated === true ||
            failureAccountId?.truncated === true ||
            failureChannel?.truncated === true ||
            threadId?.truncated === true,
        mode: delivery.mode,
        targetConfigured: delivery.to !== undefined,
        ...(projectedThreadId === undefined ? {} : { threadId: projectedThreadId }),
    };
}

function projectSchedule(schedule: OpenClawCronProviderSchedule) {
    switch (schedule.kind) {
        case "at": {
            const at = safeLabelProjection(schedule.at, "invalid", 128);
            return {
                at: at.text,
                kind: schedule.kind,
                truncated: at.truncated || !openClawCronAtScheduleIsValid(at.text),
            };
        }
        case "every": {
            return {
                ...(schedule.anchorMs === undefined
                    ? {}
                    : { anchorMs: schedule.anchorMs }),
                everyMs: schedule.everyMs,
                kind: schedule.kind,
                truncated: false as const,
            };
        }
        case "cron": {
            const expr = safeLabelProjection(schedule.expr, "invalid", 256);
            const tz =
                schedule.tz === undefined
                    ? undefined
                    : safeLabelProjection(schedule.tz, "invalid", 128);
            return {
                expr: expr.text,
                kind: schedule.kind,
                ...(schedule.staggerMs === undefined
                    ? {}
                    : { staggerMs: schedule.staggerMs }),
                ...(tz === undefined ? {} : { tz: tz.text }),
                truncated: expr.truncated || tz?.truncated === true,
            };
        }
        case "on-exit": {
            return {
                commandRedacted: true as const,
                kind: schedule.kind,
                workingDirectoryConfigured: schedule.cwd !== undefined,
            };
        }
        case "stream": {
            return {
                argumentCount: schedule.command.length,
                ...(schedule.batchMs === undefined ? {} : { batchMs: schedule.batchMs }),
                commandRedacted: true as const,
                kind: schedule.kind,
                matchConfigured: schedule.match !== undefined,
                ...(schedule.maxBatchBytes === undefined
                    ? {}
                    : { maxBatchBytes: schedule.maxBatchBytes }),
                ...(schedule.mode === undefined ? {} : { mode: schedule.mode }),
                workingDirectoryConfigured: schedule.cwd !== undefined,
            };
        }
    }
}

function projectPayload(payload: OpenClawCronProviderPayload) {
    switch (payload.kind) {
        case "systemEvent": {
            const text = truncate(payload.text, openClawCronPayloadTextMaximumLength);
            return { kind: "system-event" as const, ...text };
        }
        case "agentTurn": {
            const message = truncate(
                payload.message,
                openClawCronPayloadTextMaximumLength
            );
            const model =
                payload.model === undefined
                    ? undefined
                    : safeLabelProjection(payload.model, "unknown", 256);
            const thinking =
                payload.thinking === undefined
                    ? undefined
                    : safeLabelProjection(payload.thinking, "unknown", 128);
            return {
                kind: "agent-turn" as const,
                ...(payload.lightContext === undefined
                    ? {}
                    : { lightContext: payload.lightContext }),
                message: message.text,
                ...(model === undefined ? {} : { model: model.text }),
                ...(thinking === undefined ? {} : { thinking: thinking.text }),
                ...(payload.timeoutSeconds === undefined
                    ? {}
                    : { timeoutSeconds: payload.timeoutSeconds }),
                truncated:
                    message.truncated ||
                    model?.truncated === true ||
                    thinking?.truncated === true,
            };
        }
        case "command": {
            return {
                argumentCount: payload.argv.length,
                contentRedacted: true as const,
                kind: payload.kind,
            };
        }
        case "script": {
            return {
                contentRedacted: true as const,
                kind: payload.kind,
            };
        }
        case "heartbeat": {
            return { kind: payload.kind };
        }
    }
}

function desiredEnabledAt(
    intent: OpenClawCronActiveDisableIntent,
    nowMs: number
): { enabled: boolean; expired: boolean } {
    const expired = intent.expiresAtMs !== undefined && intent.expiresAtMs <= nowMs;
    return { enabled: expired, expired };
}

function projectSynchronization(
    actualEnabled: boolean,
    intent: OpenClawCronActiveDisableIntent | undefined,
    freshness: OpenClawCronFreshness,
    nowMs: number
): OpenClawCronJob["synchronization"] {
    if (intent === undefined) return { state: "confirmed" };
    const effective = desiredEnabledAt(intent, nowMs);
    const disableIntent = {
        ...(intent.expiresAtMs === undefined ? {} : { expiresAtMs: intent.expiresAtMs }),
        reason: intent.reason,
        recordedAtMs: intent.recordedAtMs,
        revision: intent.revision,
    };
    if (actualEnabled === effective.enabled) {
        return {
            desiredEnabled: effective.enabled,
            disableIntent,
            state: "confirmed",
        };
    }
    return {
        desiredEnabled: effective.enabled,
        disableIntent,
        state:
            effective.expired || freshness.kind === "last-known-good"
                ? "pending"
                : "conflict",
    };
}

const openClawCronHeartbeatProviderJobSchema = v.object({
    enabled: v.boolean("OpenClaw cron enabled state is invalid"),
    id: openClawCronJobIdSchema,
    state: v.object({
        lastDurationMs: v.optional(openClawCronTimestampSchema),
        lastRunAtMs: v.optional(openClawCronTimestampSchema),
        lastRunStatus: v.optional(v.picklist(["error", "ok", "skipped"])),
        nextRunAtMs: v.optional(openClawCronTimestampSchema),
        runningAtMs: v.optional(openClawCronTimestampSchema),
    }),
});

/** Minimal validated provider projection retained by the owned heartbeat inventory. */
export type OpenClawCronHeartbeatJobSummary = Readonly<{
    desiredEnabled?: boolean;
    enabled: boolean;
    id: string;
    lastDurationMs?: number;
    lastRunAtMs?: number;
    lastRunStatus?: "error" | "ok" | "skipped";
    nextRunAtMs?: number;
    runningAtMs?: number;
    synchronization: "confirmed" | "conflict" | "pending";
}>;

/**
 * Projects only the fields needed by heartbeat without copying schedule or payload text.
 * @returns A bounded identity-bearing summary for process-local correlation only.
 */
export function projectOpenClawCronHeartbeatJobSummary(
    job: OpenClawCronProviderJob,
    intent: OpenClawCronActiveDisableIntent | undefined,
    freshness: OpenClawCronFreshness,
    nowMs: number
): OpenClawCronHeartbeatJobSummary {
    const parsed = parseProviderProjection(openClawCronHeartbeatProviderJobSchema, job);
    const synchronization = projectSynchronization(
        parsed.enabled,
        intent,
        freshness,
        nowMs
    );
    return Object.freeze({
        ...(synchronization.desiredEnabled === undefined
            ? {}
            : { desiredEnabled: synchronization.desiredEnabled }),
        enabled: parsed.enabled,
        id: parsed.id,
        ...(parsed.state.lastDurationMs === undefined
            ? {}
            : { lastDurationMs: parsed.state.lastDurationMs }),
        ...(parsed.state.lastRunAtMs === undefined
            ? {}
            : { lastRunAtMs: parsed.state.lastRunAtMs }),
        ...(parsed.state.lastRunStatus === undefined
            ? {}
            : { lastRunStatus: parsed.state.lastRunStatus }),
        ...(parsed.state.nextRunAtMs === undefined
            ? {}
            : { nextRunAtMs: parsed.state.nextRunAtMs }),
        ...(parsed.state.runningAtMs === undefined
            ? {}
            : { runningAtMs: parsed.state.runningAtMs }),
        synchronization: synchronization.state,
    });
}

export function projectOpenClawCronJob(
    job: OpenClawCronProviderJob,
    intent: OpenClawCronActiveDisableIntent | undefined,
    freshness: OpenClawCronFreshness,
    nowMs: number,
    dashboardOpenLinkedTask?: OpenClawCronLinkedTask
): OpenClawCronJob {
    const id = parseProviderProjection(openClawCronJobIdSchema, job.id);
    const configRevision =
        job.configRevision === undefined
            ? undefined
            : parseProviderProjection(
                  openClawCronConfigRevisionSchema,
                  job.configRevision
              );
    const sessionTarget = ["current", "isolated", "main"].includes(job.sessionTarget)
        ? (job.sessionTarget as "current" | "isolated" | "main")
        : "named-session";
    const description = optionalText(job.description, 4000);
    const name = safeLabelProjection(job.name, id, 256);
    const agentId =
        job.agentId === undefined
            ? undefined
            : safeLabelProjection(job.agentId, "unknown", 128);
    return parseProviderProjection(openClawCronJobSchema, {
        ...(agentId === undefined || agentId.truncated ? {} : { agentId: agentId.text }),
        agentIdTruncated: agentId?.truncated ?? false,
        ...(configRevision === undefined ? {} : { configRevision }),
        createdAtMs: job.createdAtMs,
        ...(dashboardOpenLinkedTask === undefined ? {} : { dashboardOpenLinkedTask }),
        ...(description.text === undefined ? {} : { description: description.text }),
        descriptionTruncated: description.truncated,
        ...(job.delivery === undefined
            ? {}
            : { delivery: projectDelivery(job.delivery) }),
        deliveryMode: job.delivery?.mode ?? "unspecified",
        enabled: job.enabled,
        id,
        name: name.text,
        nameTruncated: name.truncated,
        payload: projectPayload(job.payload),
        schedule: projectSchedule(job.schedule),
        ...(job.scratch === undefined
            ? {}
            : {
                  scratch: {
                      content: job.scratch.content.slice(
                          0,
                          openClawCronPayloadTextMaximumLength
                      ),
                      revision: job.scratch.revision,
                      truncated:
                          job.scratch.content.length >
                          openClawCronPayloadTextMaximumLength,
                  },
              }),
        sessionTarget,
        source: "openclaw",
        state: {
            ...(job.state.consecutiveErrors === undefined
                ? {}
                : { consecutiveErrors: job.state.consecutiveErrors }),
            ...(job.state.lastDeliveryStatus === undefined
                ? {}
                : { lastDeliveryStatus: job.state.lastDeliveryStatus }),
            ...(job.state.lastDurationMs === undefined
                ? {}
                : { lastDurationMs: job.state.lastDurationMs }),
            ...(job.state.lastErrorReason === undefined
                ? {}
                : { lastErrorReason: job.state.lastErrorReason }),
            ...(job.state.lastRunAtMs === undefined
                ? {}
                : { lastRunAtMs: job.state.lastRunAtMs }),
            ...(job.state.lastRunStatus === undefined
                ? {}
                : { lastRunStatus: job.state.lastRunStatus }),
            ...(job.state.nextRunAtMs === undefined
                ? {}
                : { nextRunAtMs: job.state.nextRunAtMs }),
            ...(job.state.runningAtMs === undefined
                ? {}
                : { runningAtMs: job.state.runningAtMs }),
            ...(job.state.streamStatus === undefined
                ? {}
                : { streamStatus: job.state.streamStatus }),
        },
        synchronization: projectSynchronization(job.enabled, intent, freshness, nowMs),
        updatedAtMs: job.updatedAtMs,
        wakeMode: job.wakeMode,
    });
}

export function freshOpenClawCronSource(observedAtMs: number): OpenClawCronFreshness {
    return { kind: "fresh", observedAtMs };
}

export function lastKnownGoodOpenClawCronSource(
    observedAtMs: number,
    staleSinceMs: number
): OpenClawCronFreshness {
    return { kind: "last-known-good", observedAtMs, staleSinceMs };
}

export function projectOpenClawCronGetResult(
    job: OpenClawCronProviderJob,
    intent: OpenClawCronActiveDisableIntent | undefined,
    freshness: OpenClawCronFreshness,
    nowMs: number,
    dashboardOpenLinkedTask?: OpenClawCronLinkedTask
): GetOpenClawCronResult {
    return parseProviderProjection(getOpenClawCronResultSchema, {
        freshness,
        job: projectOpenClawCronJob(
            job,
            intent,
            freshness,
            nowMs,
            dashboardOpenLinkedTask
        ),
    });
}

export async function projectOpenClawCronListResult(
    page: OpenClawCronProviderListPage,
    activeIntent: (
        job: OpenClawCronProviderJob
    ) => Promise<OpenClawCronActiveDisableIntent | undefined>,
    freshness: OpenClawCronFreshness,
    nowMs: number,
    dashboardOpenLinkedTasks: ReadonlyMap<string, OpenClawCronLinkedTask> = new Map()
): Promise<ListOpenClawCronResult> {
    const jobs = await Promise.all(
        page.jobs.map(async (job) =>
            projectOpenClawCronJob(
                job,
                await activeIntent(job),
                freshness,
                nowMs,
                dashboardOpenLinkedTasks.get(job.id)
            )
        )
    );
    return parseProviderProjection(listOpenClawCronResultSchema, {
        freshness,
        hasMore: page.hasMore,
        jobs,
        limit: page.limit,
        ...(page.nextOffset === null ? {} : { nextOffset: page.nextOffset }),
        offset: page.offset,
        snapshotRevision: page.snapshotRevision,
        total: page.total,
    });
}

function projectedUsage(entry: OpenClawCronProviderRunEntry) {
    if (entry.usage === undefined) return;
    const usage = {
        ...(entry.usage.cache_read_tokens === undefined
            ? {}
            : { cacheReadTokens: entry.usage.cache_read_tokens }),
        ...(entry.usage.cache_write_tokens === undefined
            ? {}
            : { cacheWriteTokens: entry.usage.cache_write_tokens }),
        ...(entry.usage.input_tokens === undefined
            ? {}
            : { inputTokens: entry.usage.input_tokens }),
        ...(entry.usage.output_tokens === undefined
            ? {}
            : { outputTokens: entry.usage.output_tokens }),
        ...(entry.usage.total_tokens === undefined
            ? {}
            : { totalTokens: entry.usage.total_tokens }),
    };
    return Object.keys(usage).length === 0 ? undefined : usage;
}

export function projectOpenClawCronRun(
    entry: OpenClawCronProviderRunEntry,
    legacyDuplicateOrdinal = 0
): OpenClawCronRun {
    const errorReason =
        entry.errorReason !== undefined &&
        openClawCronFailureReasons.includes(entry.errorReason)
            ? entry.errorReason
            : undefined;
    const usage = projectedUsage(entry);
    const summary =
        entry.summary === undefined ? undefined : truncate(entry.summary, 4000);
    const model =
        entry.model === undefined
            ? undefined
            : safeLabelProjection(entry.model, "unknown", 256);
    const provider =
        entry.provider === undefined
            ? undefined
            : safeLabelProjection(entry.provider, "unknown", 128);
    const runId =
        entry.runId ??
        `synthetic:${sha256Hex(`${JSON.stringify(entry)}\0${legacyDuplicateOrdinal}`)}`;
    return parseProviderProjection(openClawCronRunSchema, {
        completedAtMs: entry.ts,
        deliveryStatus: entry.deliveryStatus ?? "not-requested",
        ...(entry.durationMs === undefined ? {} : { durationMs: entry.durationMs }),
        ...(errorReason === undefined ? {} : { errorReason }),
        jobId: entry.jobId,
        ...(model === undefined ? {} : { model: model.text }),
        modelTruncated: model?.truncated ?? false,
        ...(provider === undefined ? {} : { provider: provider.text }),
        providerTruncated: provider?.truncated ?? false,
        ...(entry.runAtMs === undefined ? {} : { runAtMs: entry.runAtMs }),
        runId: safeLabel(runId, "unknown", 256),
        status: entry.status ?? "unknown",
        ...(summary === undefined ? {} : { summary: summary.text }),
        summaryTruncated: summary?.truncated ?? false,
        ...(usage === undefined ? {} : { usage }),
    });
}

export function projectOpenClawCronRunsResult(
    page: OpenClawCronProviderRunPage,
    freshness: OpenClawCronFreshness
): ListOpenClawCronRunsResult {
    const legacyOccurrences = new Map<string, number>();
    return parseProviderProjection(listOpenClawCronRunsResultSchema, {
        freshness,
        hasMore: page.hasMore,
        limit: page.limit,
        ...(page.nextOffset === null ? {} : { nextOffset: page.nextOffset }),
        offset: page.offset,
        runs: page.entries.map((entry) => {
            if (entry.runId !== undefined) return projectOpenClawCronRun(entry);
            const fingerprint = JSON.stringify(entry);
            const ordinal = legacyOccurrences.get(fingerprint) ?? 0;
            legacyOccurrences.set(fingerprint, ordinal + 1);
            return projectOpenClawCronRun(entry, ordinal);
        }),
        total: page.total,
    });
}
