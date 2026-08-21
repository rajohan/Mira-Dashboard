import { Effect } from "effect";
import * as v from "valibot";

import {
    deliveryOverviewCacheKey,
    deliveryOverviewCacheKeys,
    deliveryOverviewSectionIds,
    deliveryOverviewSectionKeys,
    deliveryOverviewSectionPayloadSchemas,
    deliveryOverviewSectionSchemaIds,
    deliveryOverviewSectionSources,
} from "../../../contracts/delivery.ts";
import {
    deliveryGitHubActionKey,
    type DeliveryJobExecutionPort,
    type DeliveryJobOperationResult,
    deliveryJobActionKeyForPayload,
    type DeliveryOverviewPreviousSections,
    type DeliveryOverviewSectionRefreshResult,
    deliveryPreviewActionKey,
    deliveryProductionActionKey,
    parseDeliveryOperationJobPayload,
} from "../../../contracts/deliveryWorker.ts";
import {
    type JobActionExecutionContext,
    type JobActionExecutor,
    JobActionOutcomeUnknownError,
    JobActionRetryableError,
} from "./actionRegistry.ts";

export type { DeliveryJobExecutionPort } from "../../../contracts/deliveryWorker.ts";

const deliveryOverviewTtlMs = 5 * 60_000;

function elapsed(startedAt: number): number {
    return Math.max(0, Math.floor(performance.now() - startedAt));
}

function previousSections(
    port: DeliveryJobExecutionPort
): DeliveryOverviewPreviousSections {
    return Object.freeze(
        Object.fromEntries(
            deliveryOverviewSectionIds.flatMap((section) => {
                const parsed = v.safeParse(
                    deliveryOverviewSectionPayloadSchemas[section],
                    port.readPrevious(section)
                );
                return parsed.success ? [[section, parsed.output] as const] : [];
            })
        )
    );
}

function parseRefreshResults(
    input: readonly DeliveryOverviewSectionRefreshResult[]
): readonly DeliveryOverviewSectionRefreshResult[] {
    if (input.length !== deliveryOverviewSectionIds.length) {
        throw new TypeError("Delivery overview refresh result is invalid");
    }
    const bySection = new Map(input.map((result) => [result.section, result] as const));
    if (
        bySection.size !== deliveryOverviewSectionIds.length ||
        deliveryOverviewSectionIds.some((section) => !bySection.has(section))
    ) {
        throw new TypeError("Delivery overview refresh result is invalid");
    }
    return Object.freeze(
        deliveryOverviewSectionIds.map((section) => {
            const result = bySection.get(section)!;
            if (result.state === "failed") return Object.freeze(result);
            return Object.freeze({
                payload: v.parse(
                    deliveryOverviewSectionPayloadSchemas[section],
                    result.payload
                ),
                section,
                state: "succeeded" as const,
            }) as DeliveryOverviewSectionRefreshResult;
        })
    );
}

async function persistSection(
    context: JobActionExecutionContext,
    result: DeliveryOverviewSectionRefreshResult,
    durationMs: number
): Promise<void> {
    const section = result.section;
    if (result.state === "failed") {
        await context.commitCacheAttempt({
            durationMs,
            failureCode: `provider/delivery-${section}-unavailable`,
            failureMessage: "Delivery section projection could not be collected.",
            key: deliveryOverviewSectionKeys[section],
            kind: "failed",
        });
        return;
    }
    await context.commitCacheAttempt({
        durationMs,
        entries: [
            {
                key: deliveryOverviewSectionKeys[section],
                metadata: { kind: `delivery-overview-${section}` },
                payload: result.payload,
                schemaId: deliveryOverviewSectionSchemaIds[section],
                source: deliveryOverviewSectionSources[section],
                ttlMs: deliveryOverviewTtlMs,
            },
        ],
        kind: "succeeded",
    });
}

async function persistRefresh(
    context: JobActionExecutionContext,
    results: readonly DeliveryOverviewSectionRefreshResult[],
    durationMs: number
): Promise<boolean> {
    const settled = await Promise.allSettled(
        results.map((result) => persistSection(context, result, durationMs))
    );
    return (
        results.every(({ state }) => state === "succeeded") &&
        settled.every(({ status }) => status === "fulfilled")
    );
}

async function writePostSettlementWarning(
    context: JobActionExecutionContext,
    message: string
): Promise<void> {
    try {
        await Effect.runPromise(context.writeOutput("stderr", message));
    } catch {
        // Diagnostics after an external effect must not replace its durable truth.
    }
}

async function refreshAfterSettlement(
    port: DeliveryJobExecutionPort,
    context: JobActionExecutionContext,
    previous: DeliveryOverviewPreviousSections,
    startedAt: number,
    signal: AbortSignal
): Promise<readonly ["delivery-overview-refresh-failed"] | readonly []> {
    try {
        const refreshed = parseRefreshResults(await port.refresh(previous, signal));
        if (await persistRefresh(context, refreshed, elapsed(startedAt))) return [];
    } catch {
        // The external operation result remains authoritative.
    }
    await writePostSettlementWarning(
        context,
        "The Delivery operation settled, but one or more overview sections failed to refresh; the durable job result remains authoritative."
    );
    return ["delivery-overview-refresh-failed"] as const;
}

/**
 * Creates the scheduled worker-owned four-section Delivery projection.
 * @returns The claim-fenced scheduled executor.
 */
export function createDeliveryOverviewJobExecutor(
    port: DeliveryJobExecutionPort
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                v.parse(
                    v.strictObject({ key: v.literal(deliveryOverviewCacheKey) }),
                    rawPayload
                );
                const startedAt = performance.now();
                try {
                    const refreshed = parseRefreshResults(
                        await port.refresh(previousSections(port), signal)
                    );
                    if (!(await persistRefresh(context, refreshed, elapsed(startedAt)))) {
                        throw new Error("Delivery overview refresh was incomplete");
                    }
                    return {
                        cacheKeys: deliveryOverviewCacheKeys,
                        completedAtMs: context.nowMs(),
                    };
                } catch (error) {
                    throw new JobActionRetryableError(error);
                }
            },
        });
}

function operationExecutor(
    port: DeliveryJobExecutionPort,
    actionKey:
        | typeof deliveryGitHubActionKey
        | typeof deliveryPreviewActionKey
        | typeof deliveryProductionActionKey
): JobActionExecutor {
    return (context, rawPayload) =>
        Effect.tryPromise({
            catch: (error) => error,
            try: async (signal) => {
                const payload = parseDeliveryOperationJobPayload(rawPayload);
                if (deliveryJobActionKeyForPayload(payload) !== actionKey) {
                    throw new TypeError("Delivery operation job payload is invalid");
                }
                const startedAt = performance.now();
                const previous = previousSections(port);
                const result: DeliveryJobOperationResult = await port.execute(
                    payload,
                    signal,
                    context.runIdentity
                );
                if (result.operation !== payload.operation) {
                    throw new JobActionOutcomeUnknownError();
                }
                if (result.outcome === "unknown-outcome") {
                    throw new JobActionOutcomeUnknownError();
                }
                const postSettlementWarnings = await refreshAfterSettlement(
                    port,
                    context,
                    previous,
                    startedAt,
                    signal
                );
                return {
                    completedAtMs: context.nowMs(),
                    operation: result.operation,
                    outcome: result.outcome,
                    ...(result.releaseId === undefined
                        ? {}
                        : { releaseId: result.releaseId }),
                    ...(result.warnings === undefined
                        ? {}
                        : { warnings: result.warnings }),
                    ...(postSettlementWarnings.length === 0
                        ? {}
                        : { postSettlementWarnings }),
                };
            },
        });
}

export function createDeliveryGitHubJobExecutor(
    port: DeliveryJobExecutionPort
): JobActionExecutor {
    return operationExecutor(port, deliveryGitHubActionKey);
}

export function createDeliveryPreviewJobExecutor(
    port: DeliveryJobExecutionPort
): JobActionExecutor {
    return operationExecutor(port, deliveryPreviewActionKey);
}

export function createDeliveryProductionJobExecutor(
    port: DeliveryJobExecutionPort
): JobActionExecutor {
    return operationExecutor(port, deliveryProductionActionKey);
}
