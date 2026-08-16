import * as v from "valibot";

import {
    listOpenClawCronInputSchema,
    listOpenClawCronRunsInputSchema,
    openClawCronConfigRevisionSchema,
    type OpenClawCronDelivery,
    openClawCronDeliveryPatchSchema,
    openClawCronDescriptionMaximumLength,
    openClawCronEditableScheduleSchema,
    openClawCronFailureReasons,
    openClawCronJobIdSchema,
    openClawCronJobNameMaximumLength,
    openClawCronPageMaximum,
    openClawCronRunPageMaximum,
    openClawCronTimestampSchema,
} from "../../../contracts/openClawCron.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    nonnegativeSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    OpenClawCronProviderError,
    type OpenClawCronProvider,
    type OpenClawCronProviderJob,
    type OpenClawCronProviderListPage,
    type OpenClawCronProviderRunEntry,
    type OpenClawCronProviderRunPage,
    type OpenClawCronProviderUpdatePatch,
} from "../../domains/openClawCron/provider.ts";
import {
    PersistentGatewayAbortError,
    persistentGatewayCronJobChangedReason,
    PersistentGatewayRequestError,
    PersistentGatewayUnknownOutcomeError,
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
} from "./persistentGatewayTransport.ts";

/** Deadline for one bounded Gateway cron or system-info read. */
export const persistentOpenClawCronReadTimeoutMs = 15_000;

/** Deadline for one fresh admin-lane cron mutation acknowledgement. */
export const persistentOpenClawCronMutationTimeoutMs = 60_000;

const upstreamPayloadMaximumLength = 256 * 1024;
const upstreamSummaryMaximumLength = 64 * 1024;
const upstreamArgumentMaximumLength = 16 * 1024;
const upstreamArgumentMaximumCount = 128;
const upstreamDefinitionMetadataMaximumLength = 16 * 1024;

export type PersistentOpenClawCronTransport = Pick<
    PersistentGatewayTransport,
    "request" | "requestAdmin" | "snapshot"
>;

type ProviderOperation =
    | "get"
    | "list"
    | "list-runs"
    | "remove"
    | "run"
    | "set-scratch"
    | "update";

interface ProcessIdentity {
    readonly connectionGeneration: number;
    readonly processInstanceId: string;
}

const upstreamBoundedTextSchema = (maximumLength: number, message: string) =>
    v.pipe(v.string(message), v.maxLength(maximumLength, message));

const upstreamNonblankTextSchema = (maximumLength: number, message: string) =>
    v.pipe(upstreamBoundedTextSchema(maximumLength, message), v.minLength(1, message));

const upstreamSafeIntegerSchema = nonnegativeSafeIntegerSchema(
    "OpenClaw cron provider integer is invalid"
);
const upstreamProcessInstanceIdSchema = boundedControlSafeTextSchema(
    256,
    "OpenClaw Gateway process identity is invalid"
);
const upstreamRunIdSchema = boundedControlSafeTextSchema(
    256,
    "OpenClaw cron run id is invalid"
);

const upstreamDeliveryStatusSchema = v.picklist([
    "delivered",
    "not-delivered",
    "not-requested",
    "unknown",
]);
const upstreamRunStatusSchema = v.picklist(["error", "ok", "skipped"]);
const upstreamFailureReasonSchema = v.picklist(openClawCronFailureReasons);

const upstreamReportedDeliveryTargetSchema = boundedNonBlankTextSchema(
    upstreamDefinitionMetadataMaximumLength,
    "OpenClaw cron delivery target is invalid"
);
const upstreamReportedFailureDestinationSchema = v.strictObject({
    accountId: v.optional(
        upstreamBoundedTextSchema(
            upstreamDefinitionMetadataMaximumLength,
            "OpenClaw cron delivery account id is invalid"
        )
    ),
    channel: v.optional(
        upstreamBoundedTextSchema(
            upstreamDefinitionMetadataMaximumLength,
            "OpenClaw cron delivery channel is invalid"
        )
    ),
    mode: v.optional(v.picklist(["announce", "webhook"])),
    to: v.optional(upstreamReportedDeliveryTargetSchema),
});
const upstreamReportedDeliverySharedSchemas = {
    accountId: v.optional(
        upstreamBoundedTextSchema(
            upstreamDefinitionMetadataMaximumLength,
            "OpenClaw cron delivery account id is invalid"
        )
    ),
    bestEffort: v.optional(v.boolean()),
    channel: v.optional(
        upstreamBoundedTextSchema(
            upstreamDefinitionMetadataMaximumLength,
            "OpenClaw cron delivery channel is invalid"
        )
    ),
    failureDestination: v.optional(upstreamReportedFailureDestinationSchema),
    threadId: v.optional(
        v.union([
            upstreamBoundedTextSchema(
                upstreamDefinitionMetadataMaximumLength,
                "OpenClaw cron delivery thread id is invalid"
            ),
            v.pipe(v.number(), v.safeInteger()),
        ])
    ),
};
const upstreamReportedDeliverySchema = v.variant("mode", [
    v.strictObject({
        mode: v.literal("none"),
        ...upstreamReportedDeliverySharedSchemas,
        to: v.optional(upstreamReportedDeliveryTargetSchema),
    }),
    v.strictObject({
        mode: v.literal("announce"),
        ...upstreamReportedDeliverySharedSchemas,
        completionDestination: v.optional(
            v.strictObject({
                mode: v.literal("webhook"),
                to: upstreamReportedDeliveryTargetSchema,
            })
        ),
        to: v.optional(upstreamReportedDeliveryTargetSchema),
    }),
    v.strictObject({
        mode: v.literal("webhook"),
        ...upstreamReportedDeliverySharedSchemas,
        to: upstreamReportedDeliveryTargetSchema,
    }),
]);

const upstreamScheduleSchema = openClawCronEditableScheduleSchema;
const upstreamReportedScheduleSchema = v.variant("kind", [
    v.strictObject({
        at: upstreamNonblankTextSchema(
            upstreamDefinitionMetadataMaximumLength,
            "OpenClaw one-time schedule is invalid"
        ),
        kind: v.literal("at"),
    }),
    v.strictObject({
        anchorMs: v.optional(upstreamSafeIntegerSchema),
        everyMs: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        kind: v.literal("every"),
    }),
    v.strictObject({
        expr: upstreamNonblankTextSchema(
            upstreamDefinitionMetadataMaximumLength,
            "OpenClaw cron expression is invalid"
        ),
        kind: v.literal("cron"),
        staggerMs: v.optional(upstreamSafeIntegerSchema),
        tz: v.optional(
            upstreamNonblankTextSchema(
                upstreamDefinitionMetadataMaximumLength,
                "OpenClaw cron timezone is invalid"
            )
        ),
    }),
    v.strictObject({
        command: upstreamNonblankTextSchema(4096, "OpenClaw on-exit command is invalid"),
        cwd: v.optional(
            upstreamNonblankTextSchema(1024, "OpenClaw on-exit directory is invalid")
        ),
        kind: v.literal("on-exit"),
    }),
    v.strictObject({
        batchMs: v.optional(upstreamSafeIntegerSchema),
        command: v.pipe(
            v.array(
                upstreamNonblankTextSchema(
                    upstreamArgumentMaximumLength,
                    "OpenClaw stream command is invalid"
                )
            ),
            v.minLength(1, "OpenClaw stream command is invalid"),
            v.maxLength(
                upstreamArgumentMaximumCount,
                "OpenClaw stream command is outside its budget"
            )
        ),
        cwd: v.optional(
            upstreamNonblankTextSchema(1024, "OpenClaw stream directory is invalid")
        ),
        kind: v.literal("stream"),
        match: v.optional(
            upstreamBoundedTextSchema(4096, "OpenClaw stream match expression is invalid")
        ),
        maxBatchBytes: v.optional(upstreamSafeIntegerSchema),
        mode: v.optional(v.picklist(["line", "match"])),
    }),
]);

const upstreamPayloadSchema = v.variant("kind", [
    v.object({
        kind: v.literal("systemEvent"),
        text: upstreamNonblankTextSchema(
            upstreamPayloadMaximumLength,
            "OpenClaw system-event payload is invalid"
        ),
    }),
    v.object({
        kind: v.literal("agentTurn"),
        lightContext: v.optional(v.boolean()),
        message: upstreamNonblankTextSchema(
            upstreamPayloadMaximumLength,
            "OpenClaw agent-turn payload is invalid"
        ),
        model: v.optional(
            upstreamBoundedTextSchema(
                upstreamDefinitionMetadataMaximumLength,
                "OpenClaw cron model is invalid"
            )
        ),
        thinking: v.optional(
            upstreamBoundedTextSchema(
                upstreamDefinitionMetadataMaximumLength,
                "OpenClaw thinking level is invalid"
            )
        ),
        timeoutSeconds: v.optional(upstreamSafeIntegerSchema),
    }),
    v.object({
        argv: v.pipe(
            v.array(
                upstreamNonblankTextSchema(
                    upstreamArgumentMaximumLength,
                    "OpenClaw command payload is invalid"
                )
            ),
            v.minLength(1, "OpenClaw command payload is invalid"),
            v.maxLength(
                upstreamArgumentMaximumCount,
                "OpenClaw command payload is outside its budget"
            )
        ),
        kind: v.literal("command"),
    }),
    v.object({
        kind: v.literal("script"),
        script: upstreamNonblankTextSchema(
            upstreamPayloadMaximumLength,
            "OpenClaw script payload is invalid"
        ),
    }),
    v.object({ kind: v.literal("heartbeat") }),
]);

const upstreamJobStateSchema = v.object({
    consecutiveErrors: v.optional(upstreamSafeIntegerSchema),
    lastDeliveryStatus: v.optional(upstreamDeliveryStatusSchema),
    lastDurationMs: v.optional(upstreamSafeIntegerSchema),
    lastErrorReason: v.optional(upstreamFailureReasonSchema),
    lastRunAtMs: v.optional(openClawCronTimestampSchema),
    lastRunStatus: v.optional(upstreamRunStatusSchema),
    nextRunAtMs: v.optional(openClawCronTimestampSchema),
    runningAtMs: v.optional(openClawCronTimestampSchema),
    streamStatus: v.optional(
        v.picklist(["disabled", "error", "restarting", "running", "starting", "stopped"])
    ),
});

const upstreamJobSchema = v.object({
    agentId: v.optional(
        boundedControlSafeTextSchema(512, "OpenClaw cron agent id is invalid")
    ),
    configRevision: v.optional(openClawCronConfigRevisionSchema),
    createdAtMs: openClawCronTimestampSchema,
    delivery: v.optional(upstreamReportedDeliverySchema),
    description: v.optional(
        upstreamBoundedTextSchema(
            Math.max(openClawCronDescriptionMaximumLength, 64 * 1024),
            "OpenClaw cron description is invalid"
        )
    ),
    enabled: v.boolean(),
    id: openClawCronJobIdSchema,
    name: upstreamNonblankTextSchema(
        Math.max(openClawCronJobNameMaximumLength, 4096),
        "OpenClaw cron job name is invalid"
    ),
    payload: upstreamPayloadSchema,
    schedule: upstreamReportedScheduleSchema,
    sessionTarget: boundedControlSafeTextSchema(
        upstreamDefinitionMetadataMaximumLength,
        "OpenClaw cron session target is invalid"
    ),
    state: upstreamJobStateSchema,
    updatedAtMs: openClawCronTimestampSchema,
    wakeMode: v.picklist(["next-heartbeat", "now"]),
});

const upstreamSnapshotRevisionSchema = v.pipe(
    v.string("OpenClaw cron snapshot revision is invalid"),
    v.regex(/^sha256:[A-Za-z0-9_-]{43}$/u, "OpenClaw cron snapshot revision is invalid")
);

const upstreamListPageSchema = v.strictObject({
    hasMore: v.boolean(),
    jobs: v.pipe(
        v.array(upstreamJobSchema),
        v.maxLength(openClawCronPageMaximum, "OpenClaw cron page is outside its budget")
    ),
    limit: upstreamSafeIntegerSchema,
    nextOffset: v.nullable(upstreamSafeIntegerSchema),
    offset: upstreamSafeIntegerSchema,
    snapshotRevision: upstreamSnapshotRevisionSchema,
    total: upstreamSafeIntegerSchema,
});

const upstreamUsageSchema = v.object({
    cache_read_tokens: v.optional(upstreamSafeIntegerSchema),
    cache_write_tokens: v.optional(upstreamSafeIntegerSchema),
    input_tokens: v.optional(upstreamSafeIntegerSchema),
    output_tokens: v.optional(upstreamSafeIntegerSchema),
    total_tokens: v.optional(upstreamSafeIntegerSchema),
});

const upstreamRunEntrySchema = v.object({
    deliveryStatus: v.optional(upstreamDeliveryStatusSchema),
    durationMs: v.optional(upstreamSafeIntegerSchema),
    errorReason: v.optional(upstreamFailureReasonSchema),
    jobId: openClawCronJobIdSchema,
    model: v.optional(
        upstreamBoundedTextSchema(4096, "OpenClaw cron run model is invalid")
    ),
    provider: v.optional(
        upstreamBoundedTextSchema(1024, "OpenClaw cron run provider is invalid")
    ),
    runAtMs: v.optional(openClawCronTimestampSchema),
    runId: v.optional(upstreamRunIdSchema),
    status: v.optional(upstreamRunStatusSchema),
    summary: v.optional(
        upstreamBoundedTextSchema(
            upstreamSummaryMaximumLength,
            "OpenClaw cron run summary is invalid"
        )
    ),
    ts: openClawCronTimestampSchema,
    usage: v.optional(upstreamUsageSchema),
});

const upstreamRunPageSchema = v.strictObject({
    entries: v.pipe(
        v.array(upstreamRunEntrySchema),
        v.maxLength(
            openClawCronRunPageMaximum,
            "OpenClaw cron run page is outside its budget"
        )
    ),
    hasMore: v.boolean(),
    limit: upstreamSafeIntegerSchema,
    nextOffset: v.nullable(upstreamSafeIntegerSchema),
    offset: upstreamSafeIntegerSchema,
    total: upstreamSafeIntegerSchema,
});

const upstreamSystemInfoSchema = v.object({
    processInstanceId: v.optional(upstreamProcessInstanceIdSchema),
});

const upstreamRemoveAcknowledgementSchema = v.strictObject({
    removed: v.literal(true),
});

const upstreamRunAcknowledgementSchema = v.union([
    v.strictObject({
        enqueued: v.literal(true),
        ok: v.literal(true),
        processInstanceId: upstreamProcessInstanceIdSchema,
        runId: upstreamRunIdSchema,
    }),
    v.strictObject({
        ok: v.literal(true),
        processInstanceId: v.optional(upstreamProcessInstanceIdSchema),
        ran: v.literal(false),
        reason: v.picklist(["already-running", "invalid-spec", "not-due"]),
    }),
]);
const upstreamScratchSchema = v.strictObject({
    content: upstreamBoundedTextSchema(
        upstreamPayloadMaximumLength,
        "OpenClaw cron scratch is invalid"
    ),
    revision: upstreamSafeIntegerSchema,
    updatedAtMs: v.optional(openClawCronTimestampSchema),
});
const upstreamScratchGetSchema = v.strictObject({
    currentRevision: upstreamSafeIntegerSchema,
    maxBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    scratch: v.nullable(upstreamScratchSchema),
});
const upstreamScratchSetSchema = v.strictObject({
    currentRevision: upstreamSafeIntegerSchema,
    maxBytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    ok: v.literal(true),
    scratch: upstreamScratchSchema,
});

const upstreamUpdatePayloadSchema = v.variant("kind", [
    v.strictObject({
        kind: v.literal("systemEvent"),
        text: upstreamNonblankTextSchema(
            upstreamPayloadMaximumLength,
            "OpenClaw system-event patch is invalid"
        ),
    }),
    v.strictObject({
        kind: v.literal("agentTurn"),
        lightContext: v.optional(v.boolean()),
        message: upstreamNonblankTextSchema(
            upstreamPayloadMaximumLength,
            "OpenClaw agent-turn patch is invalid"
        ),
        model: v.optional(
            v.nullable(upstreamBoundedTextSchema(256, "OpenClaw cron model is invalid"))
        ),
        thinking: v.optional(
            v.nullable(
                upstreamBoundedTextSchema(128, "OpenClaw thinking level is invalid")
            )
        ),
        timeoutSeconds: v.optional(upstreamSafeIntegerSchema),
    }),
]);

const upstreamUpdatePatchSchema = v.strictObject({
    delivery: v.optional(openClawCronDeliveryPatchSchema),
    description: v.optional(
        v.nullable(
            upstreamBoundedTextSchema(
                openClawCronDescriptionMaximumLength,
                "OpenClaw cron description patch is invalid"
            )
        )
    ),
    enabled: v.optional(v.boolean()),
    name: v.optional(
        upstreamNonblankTextSchema(
            openClawCronJobNameMaximumLength,
            "OpenClaw cron name patch is invalid"
        )
    ),
    payload: v.optional(upstreamUpdatePayloadSchema),
    schedule: v.optional(upstreamScheduleSchema),
    wakeMode: v.optional(v.picklist(["next-heartbeat", "now"])),
});

function parseBoundary<TSchema extends v.GenericSchema>(
    schema: TSchema,
    value: unknown
): v.InferOutput<TSchema> {
    const result = v.safeParse(schema, value, { abortEarly: true });
    if (!result.success) throw new OpenClawCronProviderError("invalid-data");
    return result.output;
}

function requestOptions(
    signal: AbortSignal | undefined,
    timeoutMs: number,
    onResponseBytes?: (responseBytes: number) => void
): PersistentGatewayRequestOptions {
    return {
        ...(onResponseBytes === undefined ? {} : { onResponseBytes }),
        ...(signal === undefined ? {} : { signal }),
        timeoutMs,
    };
}

function safeAbort(): PersistentGatewayAbortError {
    return new PersistentGatewayAbortError();
}

function mappedProviderFailure(
    error: unknown,
    operation: ProviderOperation,
    signal?: AbortSignal
): Error {
    if (error instanceof OpenClawCronProviderError) return error;
    if (error instanceof PersistentGatewayUnknownOutcomeError) {
        return operation === "remove" || operation === "run" || operation === "update"
            ? new OpenClawCronProviderError("unknown-outcome")
            : new OpenClawCronProviderError("unavailable");
    }
    if (signal?.aborted === true) return safeAbort();
    if (error instanceof PersistentGatewayAbortError) {
        if (signal !== undefined) return error;
        return new OpenClawCronProviderError("unavailable");
    }
    if (error instanceof PersistentGatewayRequestError) {
        if (error.code !== "INVALID_REQUEST") {
            return new OpenClawCronProviderError("unavailable");
        }
        if (
            operation === "update" &&
            error.reason === persistentGatewayCronJobChangedReason
        ) {
            return new OpenClawCronProviderError("conflict");
        }
        if (operation === "remove") {
            return new OpenClawCronProviderError("not-found");
        }
        if (operation === "run") {
            return new OpenClawCronProviderError("conflict");
        }
        return new OpenClawCronProviderError("invalid-data");
    }
    return new OpenClawCronProviderError("unavailable");
}

async function providerOperation<T>(
    operation: ProviderOperation,
    signal: AbortSignal | undefined,
    work: () => Promise<T>
): Promise<T> {
    if (signal?.aborted === true) throw safeAbort();
    try {
        return await work();
    } catch (error) {
        throw mappedProviderFailure(error, operation, signal);
    }
}

function freezeDelivery(delivery: OpenClawCronDelivery): OpenClawCronDelivery {
    return Object.freeze({
        ...delivery,
        ...(delivery.failureDestination === undefined
            ? {}
            : { failureDestination: Object.freeze(delivery.failureDestination) }),
        ...("completionDestination" in delivery &&
        delivery.completionDestination !== undefined
            ? {
                  completionDestination: Object.freeze(delivery.completionDestination),
              }
            : {}),
    });
}

function freezePayload(
    payload: OpenClawCronProviderJob["payload"]
): OpenClawCronProviderJob["payload"] {
    return payload.kind === "command"
        ? Object.freeze({ ...payload, argv: Object.freeze([...payload.argv]) })
        : Object.freeze(payload);
}

function freezeSchedule(
    schedule: OpenClawCronProviderJob["schedule"]
): OpenClawCronProviderJob["schedule"] {
    return schedule.kind === "stream"
        ? Object.freeze({
              ...schedule,
              command: Object.freeze([...schedule.command]),
          })
        : Object.freeze(schedule);
}

function parseJob(raw: unknown): OpenClawCronProviderJob {
    const job = parseBoundary(upstreamJobSchema, raw);
    return Object.freeze({
        ...job,
        ...(job.delivery === undefined ? {} : { delivery: freezeDelivery(job.delivery) }),
        payload: freezePayload(job.payload),
        schedule: freezeSchedule(job.schedule),
        state: Object.freeze(job.state),
    });
}

function mutationAcknowledgement<T>(parse: () => T): T {
    try {
        return parse();
    } catch (error) {
        if (error instanceof OpenClawCronProviderError && error.kind === "invalid-data") {
            throw new OpenClawCronProviderError("unknown-outcome");
        }
        throw error;
    }
}

function assertPageRelationships(
    page: Readonly<{
        hasMore: boolean;
        limit: number;
        nextOffset: number | null;
        offset: number;
        total: number;
    }>,
    itemCount: number,
    expectedLimit: number,
    expectedOffset: number
): void {
    const consumed = page.offset + itemCount;
    const expectedHasMore = consumed < page.total;
    if (
        !Number.isSafeInteger(consumed) ||
        page.limit !== expectedLimit ||
        page.offset !== expectedOffset ||
        itemCount > expectedLimit ||
        consumed > page.total ||
        page.hasMore !== expectedHasMore ||
        page.nextOffset !== (expectedHasMore ? consumed : null)
    ) {
        throw new OpenClawCronProviderError("invalid-data");
    }
}

function parseListPage(
    raw: unknown,
    expectedLimit: number,
    expectedOffset: number,
    responseBytes: number
): OpenClawCronProviderListPage {
    if (!Number.isSafeInteger(responseBytes) || responseBytes < 1) {
        throw new OpenClawCronProviderError("invalid-data");
    }
    const page = parseBoundary(upstreamListPageSchema, raw);
    assertPageRelationships(page, page.jobs.length, expectedLimit, expectedOffset);
    const jobs = page.jobs.map(parseJob);
    if (new Set(jobs.map(({ id }) => id)).size !== jobs.length) {
        throw new OpenClawCronProviderError("invalid-data");
    }
    return Object.freeze({
        ...page,
        jobs: Object.freeze(jobs),
        responseBytes,
    });
}

function parseRunPage(
    raw: unknown,
    expectedId: string,
    expectedLimit: number,
    expectedOffset: number
): OpenClawCronProviderRunPage {
    const page = parseBoundary(upstreamRunPageSchema, raw);
    assertPageRelationships(page, page.entries.length, expectedLimit, expectedOffset);
    if (page.entries.some(({ jobId }) => jobId !== expectedId)) {
        throw new OpenClawCronProviderError("invalid-data");
    }
    const entries: readonly OpenClawCronProviderRunEntry[] = page.entries.map((entry) =>
        Object.freeze({
            ...entry,
            ...(entry.usage === undefined ? {} : { usage: Object.freeze(entry.usage) }),
        })
    );
    return Object.freeze({ ...page, entries: Object.freeze(entries) });
}

function snapshotHasIdentity(
    snapshot: PersistentGatewayConnectionSnapshot,
    identity: ProcessIdentity | undefined
): identity is ProcessIdentity {
    return (
        identity !== undefined &&
        snapshot.phase === "connected" &&
        identity.connectionGeneration === snapshot.connectionGeneration
    );
}

function wireUpdatePatch(
    patch: OpenClawCronProviderUpdatePatch
): OpenClawCronProviderUpdatePatch {
    // The reviewed Gateway patch schema represents description clearing as an
    // empty string, while Dashboard's local contract uses an explicit null.
    return patch.description === null ? { ...patch, description: "" } : patch;
}

/**
 * Adapts the process-owned Gateway transport to the bounded OpenClaw cron port.
 * Reads stay on the persistent lane; every mutation gets a fresh admin lane.
 * @param transport Process-owned persistent Gateway transport.
 * @returns A frozen production cron provider.
 */
export function createPersistentOpenClawCronProvider(
    transport: PersistentOpenClawCronTransport
): OpenClawCronProvider {
    let processIdentity: ProcessIdentity | undefined;

    async function withScratch(
        job: OpenClawCronProviderJob,
        signal?: AbortSignal
    ): Promise<OpenClawCronProviderJob> {
        if (job.payload.kind !== "heartbeat") return job;
        const raw = await transport.requestAdmin(
            "cron.scratch.get",
            { id: job.id },
            requestOptions(signal, persistentOpenClawCronReadTimeoutMs)
        );
        const response = parseBoundary(upstreamScratchGetSchema, raw);
        return Object.freeze({
            ...job,
            scratch:
                response.scratch ??
                Object.freeze({ content: "", revision: response.currentRevision }),
        });
    }

    function currentProcessInstanceId(): string | undefined {
        const snapshot = transport.snapshot;
        if (!snapshotHasIdentity(snapshot, processIdentity)) {
            processIdentity = undefined;
            return undefined;
        }
        return processIdentity.processInstanceId;
    }

    async function refreshProcessIdentity(signal?: AbortSignal): Promise<void> {
        if (currentProcessInstanceId() !== undefined) return;
        const generation = transport.snapshot.connectionGeneration;
        try {
            const response = await transport.request(
                "system.info",
                {},
                requestOptions(signal, persistentOpenClawCronReadTimeoutMs)
            );
            const systemInfo = parseBoundary(upstreamSystemInfoSchema, response);
            const snapshot = transport.snapshot;
            if (
                systemInfo.processInstanceId === undefined ||
                snapshot.phase !== "connected" ||
                snapshot.connectionGeneration !== generation
            ) {
                processIdentity = undefined;
                return;
            }
            processIdentity = Object.freeze({
                connectionGeneration: generation,
                processInstanceId: systemInfo.processInstanceId,
            });
        } catch (error) {
            processIdentity = undefined;
            if (signal?.aborted === true) throw safeAbort();
            // Cron reads remain available, but run preflight fails closed without identity.
            if (error instanceof PersistentGatewayAbortError && signal !== undefined) {
                throw error;
            }
        }
    }

    async function get(
        input: Readonly<{ id: string; signal?: AbortSignal }>
    ): Promise<OpenClawCronProviderJob | undefined> {
        const id = parseBoundary(openClawCronJobIdSchema, input.id);
        return await providerOperation("get", input.signal, async () => {
            // Observe process identity before the job read. If the persistent lane
            // changes generation during or after the read, the synchronous
            // precondition accessor below fails closed instead of pairing an old
            // definition with a new Gateway process.
            await refreshProcessIdentity(input.signal);
            let response: unknown;
            try {
                response = await transport.request(
                    "cron.get",
                    { id },
                    requestOptions(input.signal, persistentOpenClawCronReadTimeoutMs)
                );
            } catch (error) {
                if (
                    error instanceof PersistentGatewayRequestError &&
                    error.code === "INVALID_REQUEST"
                ) {
                    return;
                }
                throw error;
            }
            const job = await withScratch(parseJob(response), input.signal);
            if (job.id !== id) throw new OpenClawCronProviderError("invalid-data");
            currentProcessInstanceId();
            return job;
        });
    }

    async function list(
        input: Parameters<OpenClawCronProvider["list"]>[0]
    ): Promise<OpenClawCronProviderListPage> {
        if (input.compact !== false || input.includeDeliveryPreviews !== false) {
            throw new OpenClawCronProviderError("invalid-data");
        }
        const {
            signal,
            compact: _compact,
            includeDeliveryPreviews: _previews,
            ...raw
        } = input;
        const parsed = parseBoundary(listOpenClawCronInputSchema, raw);
        return await providerOperation("list", signal, async () => {
            let responseBytes: number | undefined;
            const response = await transport.request(
                "cron.list",
                {
                    compact: false,
                    enabled: parsed.enabled,
                    includeDeliveryPreviews: false,
                    lastRunStatus: parsed.lastRunStatus,
                    limit: parsed.limit,
                    offset: parsed.offset,
                    ...(parsed.query === undefined ? {} : { query: parsed.query }),
                    scheduleKind: parsed.scheduleKind,
                    sortBy: parsed.sortBy,
                    sortDir: parsed.sortDir,
                },
                requestOptions(
                    signal,
                    persistentOpenClawCronReadTimeoutMs,
                    (candidate) => {
                        responseBytes =
                            responseBytes === undefined ? candidate : Number.NaN;
                    }
                )
            );
            const page = parseListPage(
                response,
                parsed.limit,
                parsed.offset,
                responseBytes ?? Number.NaN
            );
            return Object.freeze({
                ...page,
                jobs: Object.freeze(
                    await Promise.all(page.jobs.map((job) => withScratch(job, signal)))
                ),
            });
        });
    }

    async function listRuns(
        input: Parameters<OpenClawCronProvider["listRuns"]>[0]
    ): Promise<OpenClawCronProviderRunPage> {
        const { signal, ...raw } = input;
        const parsed = parseBoundary(listOpenClawCronRunsInputSchema, raw);
        return await providerOperation("list-runs", signal, async () => {
            const response = await transport.request(
                "cron.runs",
                {
                    ...(parsed.deliveryStatuses === undefined
                        ? {}
                        : { deliveryStatuses: parsed.deliveryStatuses }),
                    id: parsed.id,
                    limit: parsed.limit,
                    offset: parsed.offset,
                    scope: "job",
                    sortDir: parsed.sortDir,
                    ...(parsed.statuses === undefined
                        ? {}
                        : { statuses: parsed.statuses }),
                },
                requestOptions(signal, persistentOpenClawCronReadTimeoutMs)
            );
            return parseRunPage(response, parsed.id, parsed.limit, parsed.offset);
        });
    }

    async function remove(
        input: Parameters<OpenClawCronProvider["remove"]>[0]
    ): Promise<Readonly<{ removed: boolean }>> {
        const id = parseBoundary(openClawCronJobIdSchema, input.id);
        return await providerOperation("remove", input.signal, async () => {
            const rawResponse = await transport.requestAdmin(
                "cron.remove",
                { id },
                requestOptions(input.signal, persistentOpenClawCronMutationTimeoutMs)
            );
            const response = mutationAcknowledgement(() =>
                parseBoundary(upstreamRemoveAcknowledgementSchema, rawResponse)
            );
            return Object.freeze({ removed: response.removed });
        });
    }

    async function run(
        input: Parameters<OpenClawCronProvider["run"]>[0]
    ): Promise<Awaited<ReturnType<OpenClawCronProvider["run"]>>> {
        const id = parseBoundary(openClawCronJobIdSchema, input.id);
        const expectedProcessInstanceId = parseBoundary(
            upstreamProcessInstanceIdSchema,
            input.expectedProcessInstanceId
        );
        if (input.mode !== "force") {
            throw new OpenClawCronProviderError("invalid-data");
        }
        return await providerOperation("run", input.signal, async () => {
            const rawResponse = await transport.requestAdmin(
                "cron.run",
                { expectedProcessInstanceId, id, mode: "force" },
                requestOptions(input.signal, persistentOpenClawCronMutationTimeoutMs)
            );
            const response = mutationAcknowledgement(() =>
                parseBoundary(upstreamRunAcknowledgementSchema, rawResponse)
            );
            if (
                response.processInstanceId !== undefined &&
                response.processInstanceId !== expectedProcessInstanceId
            ) {
                throw new OpenClawCronProviderError("unknown-outcome");
            }
            if ("enqueued" in response) {
                return Object.freeze({
                    processInstanceId: response.processInstanceId,
                    ran: true,
                });
            }
            return Object.freeze({
                processInstanceId:
                    response.processInstanceId ?? expectedProcessInstanceId,
                ran: false,
                reason: response.reason,
            });
        });
    }

    async function update(
        input: Parameters<OpenClawCronProvider["update"]>[0]
    ): Promise<OpenClawCronProviderJob> {
        const id = parseBoundary(openClawCronJobIdSchema, input.id);
        const expectedConfigRevision = parseBoundary(
            openClawCronConfigRevisionSchema,
            input.expectedConfigRevision
        );
        const patch = parseBoundary(
            upstreamUpdatePatchSchema,
            input.patch
        ) as OpenClawCronProviderUpdatePatch;
        if (Object.keys(patch).length === 0) {
            throw new OpenClawCronProviderError("invalid-data");
        }
        const outboundPatch = wireUpdatePatch(patch);
        return await providerOperation("update", input.signal, async () => {
            const rawResponse = await transport.requestAdmin(
                "cron.update",
                { expectedConfigRevision, id, patch: outboundPatch },
                requestOptions(input.signal, persistentOpenClawCronMutationTimeoutMs)
            );
            const job = mutationAcknowledgement(() => parseJob(rawResponse));
            if (job.id !== id) {
                throw new OpenClawCronProviderError("unknown-outcome");
            }
            return job;
        });
    }

    async function setScratch(
        input: Parameters<OpenClawCronProvider["setScratch"]>[0]
    ): Promise<Readonly<{ revision: number }>> {
        const id = parseBoundary(openClawCronJobIdSchema, input.id);
        const expectedRevision = parseBoundary(
            upstreamSafeIntegerSchema,
            input.expectedRevision
        );
        const content = parseBoundary(
            upstreamBoundedTextSchema(
                upstreamPayloadMaximumLength,
                "OpenClaw cron scratch is invalid"
            ),
            input.content
        );
        return await providerOperation("set-scratch", input.signal, async () => {
            const raw = await transport.requestAdmin(
                "cron.scratch.set",
                { content, expectedRevision, id },
                requestOptions(input.signal, persistentOpenClawCronMutationTimeoutMs)
            );
            const response = mutationAcknowledgement(() =>
                parseBoundary(upstreamScratchSetSchema, raw)
            );
            return Object.freeze({ revision: response.scratch.revision });
        });
    }

    return Object.freeze({
        currentProcessInstanceId,
        get,
        list,
        listRuns,
        remove,
        run,
        setScratch,
        update,
    });
}
