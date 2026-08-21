import * as v from "valibot";

import {
    openClawTaskCancelInputSchema,
    openClawTaskCancelOutputSchema,
    openClawTaskGetInputSchema,
    openClawTaskGetOutputSchema,
    openClawTaskIdSchema,
    openClawTaskListInputSchema,
    openClawTaskListOutputSchema,
    openClawTaskSummarySchema,
    type OpenClawTaskCancelInput,
    type OpenClawTaskCancelOutput,
    type OpenClawTaskGetInput,
    type OpenClawTaskGetOutput,
    type OpenClawTaskListInput,
    type OpenClawTaskListOutput,
} from "../../../contracts/openClawTasks.ts";
import {
    type OpenClawTaskProvider,
    type OpenClawTaskProviderEvent,
    OpenClawTaskProviderNotFoundError,
    type OpenClawTaskProviderSubscription,
    OpenClawTaskProviderUnknownOutcomeError,
    OpenClawTaskProviderUnavailableError,
} from "./provider.ts";
import type { OpenClawTasksRealtimePublisher } from "./realtime.ts";

const openClawTaskProviderEventSchema = v.variant("kind", [
    v.strictObject({ kind: v.literal("upserted"), task: openClawTaskSummarySchema }),
    v.strictObject({ kind: v.literal("deleted"), taskId: openClawTaskIdSchema }),
    v.strictObject({ kind: v.literal("restored") }),
]);

export type OpenClawTasksServiceErrorReason =
    | "invalid-input"
    | "not-found"
    | "provider-data-invalid"
    | "provider-unavailable"
    | "unknown-outcome";

export class OpenClawTasksServiceError extends Error {
    public readonly reason: OpenClawTasksServiceErrorReason;

    public constructor(reason: OpenClawTasksServiceErrorReason, options?: ErrorOptions) {
        super(`OpenClaw task operation failed: ${reason}`, options);
        this.name = "OpenClawTasksServiceError";
        this.reason = reason;
    }
}

export interface OpenClawTasksService {
    readonly cancel: (
        input: OpenClawTaskCancelInput,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskCancelOutput>;
    readonly get: (
        input: OpenClawTaskGetInput,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskGetOutput>;
    readonly list: (
        input: OpenClawTaskListInput,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskListOutput>;
    readonly subscribe: (
        listener: (event: OpenClawTaskProviderEvent) => void | Promise<void>,
        signal?: AbortSignal
    ) => Promise<OpenClawTaskProviderSubscription>;
}

function parseInput<TSchema extends v.GenericSchema>(
    schema: TSchema,
    input: unknown
): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, input, { abortEarly: true });
    if (!parsed.success) {
        throw new OpenClawTasksServiceError("invalid-input", {
            cause: parsed.issues,
        });
    }
    return parsed.output;
}

function parseOutput<TSchema extends v.GenericSchema>(
    schema: TSchema,
    output: unknown
): v.InferOutput<TSchema> {
    const parsed = v.safeParse(schema, output, { abortEarly: true });
    if (!parsed.success) {
        throw new OpenClawTasksServiceError("provider-data-invalid", {
            cause: parsed.issues,
        });
    }
    return parsed.output;
}

function providerFailure(error: unknown): OpenClawTasksServiceError {
    if (error instanceof OpenClawTasksServiceError) return error;
    if (error instanceof OpenClawTaskProviderNotFoundError) {
        return new OpenClawTasksServiceError("not-found", { cause: error });
    }
    if (error instanceof OpenClawTaskProviderUnknownOutcomeError) {
        return new OpenClawTasksServiceError("unknown-outcome", { cause: error });
    }
    if (error instanceof OpenClawTaskProviderUnavailableError) {
        return new OpenClawTasksServiceError("provider-unavailable", {
            cause: error,
        });
    }
    return new OpenClawTasksServiceError("provider-unavailable", { cause: error });
}

/**
 * Validates every Gateway task result before exposing it to routes or listeners.
 * @param provider Source-audited OpenClaw task provider.
 * @param realtimePublisher Payload-free invalidation publisher.
 * @param onAsyncFailure Non-authoritative async failure observer.
 * @returns The validated OpenClaw task service boundary.
 */
export function createOpenClawTasksService(
    provider: OpenClawTaskProvider,
    realtimePublisher: OpenClawTasksRealtimePublisher,
    onAsyncFailure: (error: unknown) => void = () => {}
): OpenClawTasksService {
    const publishMutationInvalidation = async (): Promise<void> => {
        try {
            await realtimePublisher.publishSnapshotRequired();
        } catch (error) {
            try {
                onAsyncFailure(error);
            } catch {
                // The durable provider mutation result remains authoritative.
            }
        }
    };
    const service: OpenClawTasksService = {
        async cancel(rawInput: OpenClawTaskCancelInput, signal?: AbortSignal) {
            const input = parseInput(openClawTaskCancelInputSchema, rawInput);
            try {
                const output = parseOutput(
                    openClawTaskCancelOutputSchema,
                    await provider.cancel(input, signal)
                );
                await publishMutationInvalidation();
                return output;
            } catch (error) {
                if (error instanceof OpenClawTaskProviderNotFoundError) {
                    return v.parse(openClawTaskCancelOutputSchema, {
                        cancelled: false,
                        found: false,
                    });
                }
                if (error instanceof OpenClawTaskProviderUnknownOutcomeError) {
                    await publishMutationInvalidation();
                }
                throw providerFailure(error);
            }
        },
        async get(rawInput: OpenClawTaskGetInput, signal?: AbortSignal) {
            const input = parseInput(openClawTaskGetInputSchema, rawInput);
            try {
                return parseOutput(
                    openClawTaskGetOutputSchema,
                    await provider.get(input, signal)
                );
            } catch (error) {
                throw providerFailure(error);
            }
        },
        async list(rawInput: OpenClawTaskListInput, signal?: AbortSignal) {
            const input = parseInput(openClawTaskListInputSchema, rawInput);
            try {
                return parseOutput(
                    openClawTaskListOutputSchema,
                    await provider.list(input, signal)
                );
            } catch (error) {
                throw providerFailure(error);
            }
        },
        async subscribe(
            listener: (event: OpenClawTaskProviderEvent) => void | Promise<void>,
            signal?: AbortSignal
        ) {
            try {
                return await provider.subscribeTasks(async (event) => {
                    const validated = parseOutput(openClawTaskProviderEventSchema, event);
                    // The publisher accepts no provider payload by design. Browser clients
                    // re-read the bounded canonical list after this durable marker.
                    await realtimePublisher.publishSnapshotRequired();
                    await listener(validated);
                }, signal);
            } catch (error) {
                throw providerFailure(error);
            }
        },
    };
    return Object.freeze(service);
}
