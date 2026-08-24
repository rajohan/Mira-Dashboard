import { Data } from "effect";
import * as v from "valibot";

import {
    deliveryCommitShaSchema,
    deliveryExpectedHeadsSchema,
    deliveryResourceRevisionSchema,
    type DeliveryExpectedHead,
} from "../../contracts/delivery.ts";
import {
    boundedControlSafeTextSchema,
    lowercaseUuidV7Schema,
    positiveSafeIntegerSchema,
} from "../../shared/validation.ts";

export const previewMaximumDurationMs = 4 * 60 * 60 * 1000;
export const previewStartingGraceMs = 2 * 60 * 1000;
export const previewStateMaximumBytes = 64 * 1024;
export const previewFormatVersion = 1 as const;

const previewPullRequestNumberSchema = positiveSafeIntegerSchema(
    "Preview pull request number is invalid"
);
const previewTitleSchema = boundedControlSafeTextSchema(
    500,
    "Preview pull request title is invalid"
);
const previewTimestampSchema = v.pipe(
    v.number("Preview timestamp is invalid"),
    v.safeInteger("Preview timestamp is invalid"),
    v.minValue(0, "Preview timestamp is invalid")
);
const previewPublicOriginSchema = v.pipe(
    boundedControlSafeTextSchema(2048, "Preview public origin is invalid"),
    v.url("Preview public origin is invalid"),
    v.check((value) => {
        try {
            const origin = new URL(value);
            return (
                origin.protocol === "https:" &&
                origin.origin === value &&
                origin.username === "" &&
                origin.password === "" &&
                origin.pathname === "/" &&
                origin.search === "" &&
                origin.hash === ""
            );
        } catch {
            return false;
        }
    }, "Preview public origin is invalid")
);

export const previewStartRequestSchema = v.pipe(
    v.strictObject({
        expectedHeads: deliveryExpectedHeadsSchema,
        number: previewPullRequestNumberSchema,
        operationId: lowercaseUuidV7Schema("Preview operation id is invalid"),
        previewRevision: deliveryResourceRevisionSchema,
        title: previewTitleSchema,
    }),
    v.check(
        ({ expectedHeads, number }) => expectedHeads.at(-1)?.number === number,
        "Preview selected pull request does not end its exact scope"
    )
);
export type PreviewStartRequest = v.InferOutput<typeof previewStartRequestSchema>;

export const previewStopRequestSchema = v.strictObject({
    number: previewPullRequestNumberSchema,
    operationId: lowercaseUuidV7Schema("Preview operation id is invalid"),
    previewRevision: deliveryResourceRevisionSchema,
});
export type PreviewStopRequest = v.InferOutput<typeof previewStopRequestSchema>;

export const previewCleanupRequestSchema = v.strictObject({
    expectedHeadSha: deliveryCommitShaSchema,
    number: previewPullRequestNumberSchema,
    operationId: lowercaseUuidV7Schema("Preview operation id is invalid"),
});
export type PreviewCleanupRequest = v.InferOutput<typeof previewCleanupRequestSchema>;

export const previewDurableStatusSchema = v.picklist(
    ["failed", "running", "starting", "stopped", "stopping"],
    "Preview status is invalid"
);
export type PreviewDurableStatus = v.InferOutput<typeof previewDurableStatusSchema>;

const previewDurableRecordObjectSchema = v.strictObject({
    expectedHeads: deliveryExpectedHeadsSchema,
    expiresAtMs: previewTimestampSchema,
    formatVersion: v.literal(previewFormatVersion),
    number: previewPullRequestNumberSchema,
    operationId: lowercaseUuidV7Schema("Preview operation id is invalid"),
    ownsTailscaleServe: v.boolean("Preview publication ownership is invalid"),
    previewRevision: deliveryResourceRevisionSchema,
    publicOrigin: previewPublicOriginSchema,
    reason: v.optional(
        boundedControlSafeTextSchema(160, "Preview failure reason is invalid")
    ),
    startedAtMs: v.optional(previewTimestampSchema),
    status: previewDurableStatusSchema,
    title: previewTitleSchema,
    updatedAtMs: previewTimestampSchema,
});
export type PreviewDurableRecord = v.InferOutput<typeof previewDurableRecordObjectSchema>;

function durableRecordIsConsistent(record: PreviewDurableRecord): boolean {
    const selected = record.expectedHeads.at(-1);
    if (
        selected?.number !== record.number ||
        record.updatedAtMs > record.expiresAtMs ||
        (record.status !== "stopped" &&
            record.expiresAtMs - record.updatedAtMs > previewMaximumDurationMs)
    ) {
        return false;
    }
    return (
        (record.status === "running" ? record.ownsTailscaleServe : true) &&
        (record.status === "stopped" ? !record.ownsTailscaleServe : true) &&
        (record.status === "starting"
            ? record.startedAtMs === undefined
            : record.startedAtMs !== undefined || record.status === "stopped") &&
        (record.startedAtMs === undefined || record.startedAtMs <= record.updatedAtMs)
    );
}

export const previewDurableRecordSchema = v.pipe(
    previewDurableRecordObjectSchema,
    v.check(durableRecordIsConsistent, "Preview state is inconsistent")
);

export type PreviewRuntimeState = Readonly<{
    active: boolean;
    ready: boolean;
    result?: "failed" | "success";
}>;

export interface PreviewScopeAuthority {
    readonly readScope: (
        number: number,
        signal?: AbortSignal
    ) => Promise<
        Readonly<{
            expectedHeads: readonly DeliveryExpectedHead[];
            mainRooted: boolean;
            open: boolean;
            trustedAuthors: boolean;
        }>
    >;
    readonly confirmClosedOrMerged: (
        number: number,
        expectedHeadSha: string,
        signal?: AbortSignal
    ) => Promise<boolean>;
}

export class PreviewHostError extends Data.TaggedError("PreviewHostError")<{
    readonly reason:
        | "cleanup-not-authorized"
        | "invalid-request"
        | "operation-failed"
        | "path-unsafe"
        | "preview-expired"
        | "scope-changed"
        | "slot-conflict"
        | "state-conflict"
        | "state-unavailable"
        | "untrusted-author";
}> {}

export function parsePreviewStartRequest(input: unknown): PreviewStartRequest {
    try {
        return v.parse(previewStartRequestSchema, input);
    } catch {
        throw new PreviewHostError({ reason: "invalid-request" });
    }
}

export function parsePreviewStopRequest(input: unknown): PreviewStopRequest {
    try {
        return v.parse(previewStopRequestSchema, input);
    } catch {
        throw new PreviewHostError({ reason: "invalid-request" });
    }
}

export function parsePreviewCleanupRequest(input: unknown): PreviewCleanupRequest {
    try {
        return v.parse(previewCleanupRequestSchema, input);
    } catch {
        throw new PreviewHostError({ reason: "invalid-request" });
    }
}
