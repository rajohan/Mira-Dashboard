import * as v from "valibot";

import { fullCommitShaSchema } from "./validation.ts";

const invalidPublishedReleaseAuthority = "Published release authority is invalid";

const publishedReleaseReceiptAssetSchema = v.strictObject({
    digest: v.pipe(v.string(), v.regex(/^sha256:[a-f\d]{64}$/u)),
    name: v.literal("receipt.json"),
    size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

const publishedReleaseArchiveAssetSchema = v.strictObject({
    digest: v.pipe(v.string(), v.regex(/^sha256:[a-f\d]{64}$/u)),
    name: v.literal("release.tar"),
    size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});

export const publishedReleaseAssetSchema = v.variant("name", [
    publishedReleaseReceiptAssetSchema,
    publishedReleaseArchiveAssetSchema,
]);

const publishedReleaseAssetsSchema = v.union([
    v.tuple([publishedReleaseReceiptAssetSchema, publishedReleaseArchiveAssetSchema]),
    v.tuple([publishedReleaseArchiveAssetSchema, publishedReleaseReceiptAssetSchema]),
]);

/** Exact GitHub release identity authorized by one Delivery deployment request. */
export const publishedReleaseAuthoritySchema = v.strictObject({
    assets: publishedReleaseAssetsSchema,
    releaseId: fullCommitShaSchema(invalidPublishedReleaseAuthority),
    releaseManifestSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    runtime: v.strictObject({
        revision: fullCommitShaSchema(invalidPublishedReleaseAuthority),
        version: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    tagName: v.pipe(v.string(), v.regex(/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u)),
});

export type PublishedReleaseAuthority = Readonly<
    v.InferOutput<typeof publishedReleaseAuthoritySchema>
>;
