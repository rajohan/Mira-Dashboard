import * as v from "valibot";

import { compareStrings, hasUniqueArrayItems } from "../shared/validation.ts";
import {
    dockerContainerIdSchema,
    dockerImageReferenceSchema,
    dockerImageMaximum,
    dockerObjectIdSchema,
    dockerSourceRevisionSchema,
    dockerUpdaterServiceIdSchema,
    dockerVolumeMaximum,
    dockerVolumeNameSchema,
} from "./docker.ts";
import type { DockerOverviewCachePayload, DockerUpdaterEvent } from "./docker.ts";

function canonicalIdentifiers<
    TSchema extends v.BaseSchema<unknown, string, v.BaseIssue<unknown>>,
>(itemSchema: TSchema, maximum: number, message: string) {
    return v.pipe(
        v.array(itemSchema, message),
        v.maxLength(maximum, message),
        v.check(
            (items) =>
                hasUniqueArrayItems(items) &&
                items.every(
                    (item, index) =>
                        index === 0 || compareStrings(items[index - 1]!, item) < 0
                ),
            message
        )
    );
}

const sourceRevision = { sourceRevision: dockerSourceRevisionSchema };
const containerOperations = [
    "container-restart",
    "container-start",
    "container-stop",
] as const;
const stackOperations = ["stack-restart", "stack-start", "stack-stop"] as const;

const containerSchemas = containerOperations.map((operation) =>
    v.strictObject({
        containerId: dockerContainerIdSchema,
        operation: v.literal(operation),
        ...sourceRevision,
    })
);
const stackSchemas = stackOperations.map((operation) =>
    v.strictObject({ operation: v.literal(operation), ...sourceRevision })
);

/**
 * Exact worker-owned Docker command payload. Confirmations and idempotency keys remain
 * web-admission concerns and never become generic worker command authority.
 */
export const dockerOperationJobPayloadSchema = v.union([
    ...containerSchemas,
    v.strictObject({
        imageId: dockerObjectIdSchema,
        operation: v.literal("image-delete"),
        ...sourceRevision,
    }),
    v.strictObject({
        imageIds: canonicalIdentifiers(
            dockerObjectIdSchema,
            dockerImageMaximum,
            "Docker image prune candidates are invalid"
        ),
        operation: v.literal("prune-execute"),
        ...sourceRevision,
        target: v.literal("images"),
    }),
    v.strictObject({
        operation: v.literal("prune-execute"),
        ...sourceRevision,
        target: v.literal("volumes"),
        volumeNames: canonicalIdentifiers(
            dockerVolumeNameSchema,
            dockerVolumeMaximum,
            "Docker volume prune candidates are invalid"
        ),
    }),
    ...stackSchemas,
    v.strictObject({
        operation: v.literal("updater-run"),
        ...sourceRevision,
    }),
    v.strictObject({
        operation: v.literal("updater-scan"),
        ...sourceRevision,
    }),
    v.strictObject({
        candidateImage: dockerImageReferenceSchema,
        currentImage: dockerImageReferenceSchema,
        operation: v.literal("updater-update-service"),
        serviceId: dockerUpdaterServiceIdSchema,
        ...sourceRevision,
    }),
    v.strictObject({
        operation: v.literal("volume-delete"),
        ...sourceRevision,
        volumeName: dockerVolumeNameSchema,
    }),
]);

export type DockerOperationJobPayload = v.InferOutput<
    typeof dockerOperationJobPayloadSchema
>;

export interface DockerJobUpdaterResult {
    readonly failedCount: number;
    readonly outcome:
        | "completed"
        | "completed-with-failures"
        | "source-sync-pending"
        | "unknown-outcome";
    readonly payload: DockerOverviewCachePayload;
    readonly updatedCount: number;
}

/** Worker authority used by durable jobs; it exposes no command, path, env, or raw output. */
export interface DockerJobExecutionPort {
    readonly execute: (
        payload: DockerOperationJobPayload,
        signal?: AbortSignal
    ) => Promise<{
        readonly operation: DockerOperationJobPayload["operation"];
        readonly outcome: "completed" | "unknown-outcome";
        readonly targetCount: number;
    }>;
    readonly publishEvents?: (events: readonly DockerUpdaterEvent[]) => Promise<void>;
    readonly readPrevious: () => unknown;
    /** Latest persisted attempt state, used only to suppress repeated failure transitions. */
    readonly readPreviousAttemptStatus?: () => "failed" | "succeeded" | undefined;
    readonly refresh: (
        previous?: unknown,
        signal?: AbortSignal
    ) => Promise<DockerOverviewCachePayload>;
    readonly runUpdater: (
        input: DockerJobUpdaterInput,
        signal?: AbortSignal
    ) => Promise<DockerJobUpdaterResult>;
    readonly scan: (
        previous?: unknown,
        signal?: AbortSignal
    ) => Promise<DockerOverviewCachePayload>;
}

export type DockerJobUpdaterInput =
    | Readonly<{
          automaticOnly?: boolean;
          candidateImage?: never;
          currentImage?: never;
          expectedSourceRevision?: string;
          previous?: unknown;
          serviceId?: never;
      }>
    | Readonly<{
          automaticOnly?: never;
          candidateImage: string;
          currentImage: string;
          expectedSourceRevision: string;
          previous?: unknown;
          serviceId: string;
      }>;

/** Stable worker-to-executor signal for a harmless stale updater intent. */
export class DockerUpdaterSourceConflictError extends Error {
    constructor() {
        super("Docker updater source state changed");
        this.name = "DockerUpdaterSourceConflictError";
    }
}

/**
 * Parses the only payload shape accepted by the manual Docker worker actions.
 * @param input Untrusted durable job payload.
 * @returns One strict source-bound Docker operation payload.
 */
export function parseDockerOperationJobPayload(
    input: unknown
): DockerOperationJobPayload {
    return v.parse(dockerOperationJobPayloadSchema, input);
}
