import * as v from "valibot";

import {
    openClawTaskCancelOutputSchema,
    openClawTaskDetailSchema,
    openClawTaskGetOutputSchema,
    openClawTaskListOutputSchema,
    openClawTaskSummarySchema,
    type OpenClawTaskCancelInput,
    type OpenClawTaskCancelOutput,
    type OpenClawTaskDetail,
    type OpenClawTaskGetInput,
    type OpenClawTaskGetOutput,
    type OpenClawTaskListInput,
    type OpenClawTaskListOutput,
    type OpenClawTaskSummary,
} from "../../../contracts/openClawTasks.ts";
import {
    type OpenClawTaskProvider,
    OpenClawTaskProviderNotFoundError,
    type OpenClawTaskProviderSubscription,
    OpenClawTaskProviderUnknownOutcomeError,
    OpenClawTaskProviderUnavailableError,
} from "../../domains/openClawTasks/provider.ts";
import type {
    PersistentGatewayTaskReadMethod,
    PersistentGatewayTaskWriteMethod,
} from "./persistentGatewayProtocol.ts";
import {
    persistentGatewayTaskNotFoundReason,
    PersistentGatewayRequestError,
    type PersistentGatewayConnectionSnapshot,
    type PersistentGatewayDeliveredEvent,
    type PersistentGatewayListener,
    type PersistentGatewayRequestOptions,
    type PersistentGatewayTransport,
    PersistentGatewayUnknownOutcomeError,
} from "./persistentGatewayTransport.ts";

export const persistentGatewayTaskReadTimeoutMs = 15_000;
export const persistentGatewayTaskMutationTimeoutMs = 60_000;

export type PersistentGatewayOpenClawTasksTransport = Pick<
    PersistentGatewayTransport,
    "requestTaskRead" | "requestTaskWrite" | "subscribe"
>;

const boundedTaskText = (maximum: number) =>
    v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(maximum),
        v.check((text) => !/[\p{Cc}\p{Cf}]/u.test(text))
    );
const boundedTaskBody = (maximum: number) =>
    v.pipe(
        v.string(),
        v.minLength(1),
        v.maxLength(maximum),
        v.check((text) => !text.includes("\0"))
    );
const upstreamTimestampSchema = v.union([
    v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
]);
const upstreamTaskStatusSchema = v.picklist([
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "timed_out",
]);
const upstreamTaskSummarySchema = v.strictObject({
    agentId: v.optional(boundedTaskText(256)),
    childSessionKey: v.optional(boundedTaskText(512)),
    createdAt: v.optional(upstreamTimestampSchema),
    endedAt: v.optional(upstreamTimestampSchema),
    error: v.optional(boundedTaskBody(4000)),
    flowId: v.optional(boundedTaskText(256)),
    id: boundedTaskText(256),
    kind: v.optional(boundedTaskText(256)),
    lastToolName: v.optional(boundedTaskText(200)),
    ownerKey: v.optional(boundedTaskText(256)),
    parentTaskId: v.optional(boundedTaskText(256)),
    progressSummary: v.optional(boundedTaskBody(4000)),
    prompt: v.optional(boundedTaskBody(4000)),
    runId: v.optional(boundedTaskText(256)),
    runtime: v.optional(boundedTaskText(256)),
    sessionKey: v.optional(boundedTaskText(512)),
    sourceId: v.optional(boundedTaskText(256)),
    startedAt: v.optional(upstreamTimestampSchema),
    status: upstreamTaskStatusSchema,
    taskId: v.optional(boundedTaskText(256)),
    terminalSummary: v.optional(boundedTaskBody(4000)),
    title: v.optional(boundedTaskText(256)),
    toolUseCount: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    updatedAt: v.optional(upstreamTimestampSchema),
});
const upstreamTaskListSchema = v.strictObject({
    nextCursor: v.optional(
        v.pipe(
            v.string(),
            v.regex(/^(?:0|[1-9][0-9]*)$/u),
            v.check((cursor) => Number.isSafeInteger(Number(cursor)))
        )
    ),
    tasks: v.pipe(v.array(upstreamTaskSummarySchema), v.maxLength(200)),
});
const upstreamTaskGetSchema = v.strictObject({ task: upstreamTaskSummarySchema });
const upstreamTaskCancelSchema = v.strictObject({
    cancelled: v.boolean(),
    found: v.boolean(),
    reason: v.optional(boundedTaskBody(500)),
    task: v.optional(upstreamTaskSummarySchema),
});

function unavailable<TSchema extends v.GenericSchema>(
    schema: TSchema,
    value: unknown
): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, value, { abortEarly: true });
    if (!parsed.success) throw new OpenClawTaskProviderUnavailableError();
    return parsed.output;
}

function mutationAcknowledgement<TSchema extends v.GenericSchema>(
    schema: TSchema,
    value: unknown
): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, value, { abortEarly: true });
    if (!parsed.success) throw new OpenClawTaskProviderUnknownOutcomeError();
    return parsed.output;
}

function timestampMs(value: string | number | undefined): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value === "number") return value;
    const timestamp = Date.parse(value);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : undefined;
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
    return signal?.aborted === true;
}

function projectTask(
    value: v.InferOutput<typeof upstreamTaskSummarySchema>,
    includePrompt: false
): OpenClawTaskSummary;
function projectTask(
    value: v.InferOutput<typeof upstreamTaskSummarySchema>,
    includePrompt: true
): OpenClawTaskDetail;
function projectTask(
    value: v.InferOutput<typeof upstreamTaskSummarySchema>,
    includePrompt: boolean
): OpenClawTaskSummary | OpenClawTaskDetail {
    if (!includePrompt && value.prompt !== undefined) {
        throw new OpenClawTaskProviderUnavailableError();
    }
    const projected: Record<string, unknown> = {
        id: value.id,
        status: value.status,
    };
    for (const field of [
        "agentId",
        "childSessionKey",
        "error",
        "flowId",
        "kind",
        "lastToolName",
        "ownerKey",
        "parentTaskId",
        "progressSummary",
        "runId",
        "runtime",
        "sessionKey",
        "sourceId",
        "taskId",
        "terminalSummary",
        "title",
        "toolUseCount",
    ] as const) {
        if (value[field] !== undefined) projected[field] = value[field];
    }
    for (const [upstreamField, localField] of [
        ["createdAt", "createdAtMs"],
        ["endedAt", "endedAtMs"],
        ["startedAt", "startedAtMs"],
        ["updatedAt", "updatedAtMs"],
    ] as const) {
        if (value[upstreamField] === undefined) continue;
        const timestamp = timestampMs(value[upstreamField]);
        if (timestamp === undefined) throw new OpenClawTaskProviderUnavailableError();
        projected[localField] = timestamp;
    }
    if (includePrompt && value.prompt !== undefined) projected.prompt = value.prompt;
    return includePrompt
        ? unavailable(openClawTaskDetailSchema, projected)
        : unavailable(openClawTaskSummarySchema, projected);
}

function translateTaskFailure(error: unknown): never {
    if (error instanceof PersistentGatewayUnknownOutcomeError) {
        throw new OpenClawTaskProviderUnknownOutcomeError();
    }
    if (
        error instanceof PersistentGatewayRequestError &&
        error.reason === persistentGatewayTaskNotFoundReason
    ) {
        throw new OpenClawTaskProviderNotFoundError();
    }
    throw new OpenClawTaskProviderUnavailableError();
}

function translateTaskMutationFailure(error: unknown): never {
    if (error instanceof PersistentGatewayUnknownOutcomeError) {
        throw new OpenClawTaskProviderUnknownOutcomeError();
    }
    // tasks.cancel reports genuine absence as a successful
    // { found:false, cancelled:false } acknowledgement. A request error is a
    // protocol divergence, not an authorized local not-found projection.
    throw new OpenClawTaskProviderUnavailableError();
}

async function requestRead(
    transport: PersistentGatewayOpenClawTasksTransport,
    method: PersistentGatewayTaskReadMethod,
    parameters: Readonly<Record<string, unknown>>,
    options: PersistentGatewayRequestOptions
): Promise<unknown> {
    try {
        return await transport.requestTaskRead(method, parameters, options);
    } catch (error) {
        translateTaskFailure(error);
    }
}

async function requestWrite(
    transport: PersistentGatewayOpenClawTasksTransport,
    method: PersistentGatewayTaskWriteMethod,
    parameters: Readonly<Record<string, unknown>>,
    options: PersistentGatewayRequestOptions
): Promise<unknown> {
    try {
        return await transport.requestTaskWrite(method, parameters, options);
    } catch (error) {
        translateTaskMutationFailure(error);
    }
}

class PersistentGatewayOpenClawTasksProviderImplementation implements OpenClawTaskProvider {
    readonly #transport: PersistentGatewayOpenClawTasksTransport;

    constructor(transport: PersistentGatewayOpenClawTasksTransport) {
        this.#transport = transport;
    }

    async list(
        input: OpenClawTaskListInput,
        signal?: AbortSignal
    ): Promise<OpenClawTaskListOutput> {
        const payload = await requestRead(
            this.#transport,
            "tasks.list",
            {
                ...(input.agentId === undefined ? {} : { agentId: input.agentId }),
                ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
                limit: input.limit,
                ...(input.sessionKey === undefined
                    ? {}
                    : { sessionKey: input.sessionKey }),
                ...(input.statuses === undefined ? {} : { status: input.statuses }),
            },
            { signal, timeoutMs: persistentGatewayTaskReadTimeoutMs }
        );
        const upstream = unavailable(upstreamTaskListSchema, payload);
        if (upstream.tasks.length > input.limit) {
            throw new OpenClawTaskProviderUnavailableError();
        }
        const currentOffset = Number(input.cursor ?? "0");
        if (
            upstream.nextCursor !== undefined &&
            Number(upstream.nextCursor) !== currentOffset + upstream.tasks.length
        ) {
            throw new OpenClawTaskProviderUnavailableError();
        }
        return unavailable(openClawTaskListOutputSchema, {
            ...(upstream.nextCursor === undefined
                ? {}
                : { nextCursor: upstream.nextCursor }),
            tasks: upstream.tasks.map((task) => projectTask(task, false)),
        });
    }

    async get(
        input: OpenClawTaskGetInput,
        signal?: AbortSignal
    ): Promise<OpenClawTaskGetOutput> {
        const payload = await requestRead(
            this.#transport,
            "tasks.get",
            { taskId: input.taskId },
            { signal, timeoutMs: persistentGatewayTaskReadTimeoutMs }
        );
        const upstream = unavailable(upstreamTaskGetSchema, payload);
        if (upstream.task.id !== input.taskId) {
            throw new OpenClawTaskProviderUnavailableError();
        }
        return unavailable(openClawTaskGetOutputSchema, {
            task: projectTask(upstream.task, true),
        });
    }

    async cancel(
        input: OpenClawTaskCancelInput,
        signal?: AbortSignal
    ): Promise<OpenClawTaskCancelOutput> {
        const payload = await requestWrite(
            this.#transport,
            "tasks.cancel",
            {
                ...(input.reason === undefined ? {} : { reason: input.reason }),
                taskId: input.taskId,
            },
            { signal, timeoutMs: persistentGatewayTaskMutationTimeoutMs }
        );
        try {
            const upstream = mutationAcknowledgement(upstreamTaskCancelSchema, payload);
            if (
                upstream.found !== (upstream.task !== undefined) ||
                (upstream.task !== undefined && upstream.task.id !== input.taskId)
            ) {
                throw new OpenClawTaskProviderUnknownOutcomeError();
            }
            return mutationAcknowledgement(openClawTaskCancelOutputSchema, {
                cancelled: upstream.cancelled,
                found: upstream.found,
                ...(upstream.reason === undefined ? {} : { reason: upstream.reason }),
                ...(upstream.task === undefined
                    ? {}
                    : { task: projectTask(upstream.task, false) }),
            });
        } catch (error) {
            if (error instanceof OpenClawTaskProviderUnknownOutcomeError) throw error;
            throw new OpenClawTaskProviderUnknownOutcomeError();
        }
    }

    async subscribeTasks(
        listener: Parameters<OpenClawTaskProvider["subscribeTasks"]>[0],
        signal?: AbortSignal
    ): Promise<OpenClawTaskProviderSubscription> {
        if (signalIsAborted(signal)) {
            throw new OpenClawTaskProviderUnavailableError();
        }
        let closed = false;
        let drainPromise: Promise<null> | undefined;
        let lastConnectedGeneration: number | undefined;
        let pendingSnapshot = false;
        let unsubscribe: (() => void) | undefined;
        const completion = Promise.withResolvers<void>();
        let terminalFailure = false;
        const fail = (): void => {
            if (closed) return;
            closed = true;
            terminalFailure = true;
            signal?.removeEventListener("abort", onAbort);
            unsubscribe?.();
            completion.reject(new OpenClawTaskProviderUnavailableError());
        };
        const drain = (): void => {
            if (closed || drainPromise !== undefined || !pendingSnapshot) return;
            const active = Promise.resolve().then(async () => {
                while (!closed && pendingSnapshot) {
                    pendingSnapshot = false;
                    await listener({ kind: "restored" });
                }
                return null;
            });
            drainPromise = active;
            void active.then(
                () => {
                    if (drainPromise === active) drainPromise = undefined;
                    drain();
                    return null;
                },
                () => {
                    if (drainPromise === active) drainPromise = undefined;
                    fail();
                    return null;
                }
            );
        };
        const enqueueSnapshot = (): void => {
            if (closed) return;
            pendingSnapshot = true;
            drain();
        };
        const transportListener: PersistentGatewayListener = Object.freeze({
            onEvent: (event: PersistentGatewayDeliveredEvent) => {
                if (event.frame.event === "task") enqueueSnapshot();
            },
            onEventGap: enqueueSnapshot,
            onState: (snapshot: PersistentGatewayConnectionSnapshot) => {
                if (
                    snapshot.phase === "connected" &&
                    snapshot.connectionGeneration !== lastConnectedGeneration
                ) {
                    lastConnectedGeneration = snapshot.connectionGeneration;
                    enqueueSnapshot();
                }
            },
        });
        try {
            unsubscribe = this.#transport.subscribe(transportListener);
        } catch (error) {
            translateTaskFailure(error);
        }
        const close = async (): Promise<void> => {
            if (!closed) {
                closed = true;
                signal?.removeEventListener("abort", onAbort);
                unsubscribe?.();
            }
            if (drainPromise !== undefined) await drainPromise;
            if (!terminalFailure) completion.resolve();
        };
        const onAbort = (): void => void close();
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signalIsAborted(signal)) await close();
        return Object.freeze({ close, done: completion.promise });
    }
}

export function createPersistentGatewayOpenClawTasksProvider(
    transport: PersistentGatewayOpenClawTasksTransport
): OpenClawTaskProvider {
    return new PersistentGatewayOpenClawTasksProviderImplementation(transport);
}
