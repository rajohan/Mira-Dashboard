import { Effect } from "effect";
import * as v from "valibot";

import type { JsonObject } from "../../../shared/json.ts";
import { collectSystemHostPayload } from "../cache/systemHostProvider.ts";
import {
    type JobActionDefinition,
    type JobActionExecutor,
    type JobActionRegistration,
    JobActionRetryableError,
    jobActionDefinitions,
    validateJobActionRegistration,
} from "./actionRegistry.ts";

const emptyPayloadSchema = v.strictObject({});
const systemHostActionPayloadSchema = v.strictObject({ key: v.literal("system.host") });
const smokeResultSchema = v.strictObject({
    checkedAtMs: v.pipe(
        v.number("Worker smoke timestamp is invalid"),
        v.safeInteger("Worker smoke timestamp is invalid"),
        v.minValue(0, "Worker smoke timestamp is invalid")
    ),
    databaseReleaseId: v.pipe(
        v.string("Worker smoke release is invalid"),
        v.length(40, "Worker smoke release is invalid"),
        v.regex(/^[0-9a-f]{40}$/u, "Worker smoke release is invalid")
    ),
    status: v.literal("ok"),
    workerInstanceId: v.pipe(
        v.string("Worker smoke identity is invalid"),
        v.uuid("Worker smoke identity is invalid")
    ),
});

interface JobActionExecutorEntry {
    readonly actionKey: string;
    readonly execute: JobActionExecutor;
}

const workerSmokeExecutor: JobActionExecutor = (context, payload: JsonObject) =>
    Effect.sync(() => {
        v.parse(emptyPayloadSchema, payload);
        return v.parse(smokeResultSchema, {
            checkedAtMs: context.nowMs(),
            databaseReleaseId: context.databaseReleaseId,
            status: "ok",
            workerInstanceId: context.workerInstanceId,
        });
    });

export interface SystemHostExecutorDependencies {
    readonly collect?: typeof collectSystemHostPayload;
    readonly monotonicNowMs?: () => number;
}

/**
 * Creates the worker-only system.host executor with injectable host boundaries.
 * @param dependencies Optional host collector and monotonic clock overrides.
 * @returns A worker action executor for the system.host cache provider.
 */
export function createSystemHostExecutor(
    dependencies: SystemHostExecutorDependencies = {}
): JobActionExecutor {
    const collect = dependencies.collect ?? collectSystemHostPayload;
    const monotonicNowMs = dependencies.monotonicNowMs ?? (() => performance.now());
    return (context, payload) =>
        Effect.suspend(() => {
            v.parse(systemHostActionPayloadSchema, payload);
            const startedAt = monotonicNowMs();
            const collected = Effect.tryPromise({
                catch: (error) => new JobActionRetryableError(error),
                try: () => collect(),
            }).pipe(
                Effect.catch((error) => {
                    const durationMs = Math.max(
                        0,
                        Math.floor(monotonicNowMs() - startedAt)
                    );
                    return Effect.tryPromise(() =>
                        context.commitCacheAttempt({
                            durationMs,
                            failureCode: "provider/system-host-unavailable",
                            failureMessage:
                                "System host projection could not be collected.",
                            key: "system.host",
                            kind: "failed",
                        })
                    ).pipe(Effect.andThen(Effect.fail(error)));
                })
            );
            return collected.pipe(
                Effect.flatMap((hostPayload) => {
                    const durationMs = Math.max(
                        0,
                        Math.floor(monotonicNowMs() - startedAt)
                    );
                    return Effect.tryPromise(() =>
                        context.commitCacheAttempt({
                            durationMs,
                            entries: [
                                {
                                    key: "system.host",
                                    metadata: { kind: "host" },
                                    payload: hostPayload,
                                    schemaId: "system.host.v1",
                                    source: "system.host",
                                    ttlMs: 86_400_000,
                                },
                            ],
                            kind: "succeeded",
                        })
                    ).pipe(
                        Effect.as({
                            cacheKeys: ["system.host"],
                            completedAtMs: context.nowMs(),
                        })
                    );
                })
            );
        });
}

const systemHostExecutor = createSystemHostExecutor();

const executorEntries = Object.freeze([
    Object.freeze({
        actionKey: "cache.refresh.system-host",
        execute: systemHostExecutor,
    }),
    Object.freeze({
        actionKey: "system.worker-smoke",
        execute: workerSmokeExecutor,
    }),
] as const satisfies readonly JobActionExecutorEntry[]);

/**
 * Builds a fail-closed worker registry whose executors exactly match release definitions.
 * @param definitions Release-owned pure action definitions.
 * @param executors Worker-only executors keyed by action identity.
 * @returns A validated worker registry indexed by action key.
 */
export function createJobWorkerActionRegistry(
    definitions: readonly JobActionDefinition[],
    executors: readonly JobActionExecutorEntry[]
): ReadonlyMap<string, JobActionRegistration> {
    const definitionByKey = new Map(
        definitions.map((definition) => [definition.actionKey, definition])
    );
    const executorByKey = new Map(executors.map((entry) => [entry.actionKey, entry]));
    if (
        definitionByKey.size !== definitions.length ||
        executorByKey.size !== executors.length ||
        definitionByKey.size !== executorByKey.size ||
        [...definitionByKey.keys()].some((key) => !executorByKey.has(key))
    ) {
        throw new Error(
            "Job worker executor keys do not exactly match action definitions"
        );
    }
    return new Map(
        definitions.map((definition) => {
            const executor = executorByKey.get(definition.actionKey);
            if (executor === undefined) {
                throw new Error("Job worker executor registry is incomplete");
            }
            return [
                definition.actionKey,
                validateJobActionRegistration({
                    ...definition,
                    execute: executor.execute,
                }),
            ];
        })
    );
}

const workerActionRegistry = createJobWorkerActionRegistry(
    jobActionDefinitions,
    executorEntries
);

/**
 * Resolves one exact worker-owned executor registration.
 * @param actionKey Canonical job action key.
 * @returns The matching worker registration when implemented.
 */
export function findJobWorkerAction(
    actionKey: string
): JobActionRegistration | undefined {
    return workerActionRegistry.get(actionKey);
}
