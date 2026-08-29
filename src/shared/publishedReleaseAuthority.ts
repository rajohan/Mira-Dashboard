import * as v from "valibot";

import {
    maximumProductionReleaseArchiveBytes,
    maximumProductionReleaseReceiptBytes,
} from "./productionReleaseArtifactReceipt.ts";
import { fullCommitShaSchema } from "./validation.ts";

/** Maximum semantic tag length that keeps the derived systemd unit below 255 bytes. */
export const maximumPublishedReleaseTagLength = 34;

const invalidPublishedReleaseAuthority = "Published release authority is invalid";

const publishedReleaseReceiptAssetSchema = v.strictObject({
    digest: v.pipe(v.string(), v.regex(/^sha256:[a-f\d]{64}$/u)),
    name: v.literal("receipt.json"),
    size: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(1),
        v.maxValue(maximumProductionReleaseReceiptBytes)
    ),
});

const publishedReleaseArchiveAssetSchema = v.strictObject({
    digest: v.pipe(v.string(), v.regex(/^sha256:[a-f\d]{64}$/u)),
    name: v.literal("release.tar"),
    size: v.pipe(
        v.number(),
        v.safeInteger(),
        v.minValue(1),
        v.maxValue(maximumProductionReleaseArchiveBytes)
    ),
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
    releaseDescriptorSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    releaseManifestSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    runtime: v.strictObject({
        revision: fullCommitShaSchema(invalidPublishedReleaseAuthority),
        version: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    tagName: v.pipe(
        v.string(),
        v.maxLength(maximumPublishedReleaseTagLength),
        v.regex(/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u)
    ),
});

export type PublishedReleaseAuthority = Readonly<
    v.InferOutput<typeof publishedReleaseAuthoritySchema>
>;

/**
 * Compares every immutable field in two normalized published release authorities.
 * Asset order is provider-controlled and does not change the authorized identity.
 * @param left First normalized release authority.
 * @param right Second normalized release authority.
 * @returns Whether both values authorize the same exact published bytes and runtime.
 */
export function publishedReleaseAuthoritiesMatch(
    left: PublishedReleaseAuthority,
    right: PublishedReleaseAuthority
): boolean {
    return (
        left.releaseId === right.releaseId &&
        left.releaseDescriptorSha256 === right.releaseDescriptorSha256 &&
        left.releaseManifestSha256 === right.releaseManifestSha256 &&
        left.runtime.revision === right.runtime.revision &&
        left.runtime.version === right.runtime.version &&
        left.tagName === right.tagName &&
        left.assets.every((leftAsset) =>
            right.assets.some(
                (rightAsset) =>
                    leftAsset.name === rightAsset.name &&
                    leftAsset.digest === rightAsset.digest &&
                    leftAsset.size === rightAsset.size
            )
        )
    );
}
