import * as v from "valibot";

/** Maximum logical bytes admitted in one unpacked production release tree. */
export const maximumProductionReleaseArtifactTreeBytes = 512 * 1024 * 1024;

/** Maximum accepted archive size, including bounded tar headers around a 512 MiB tree. */
export const maximumProductionReleaseArchiveBytes =
    maximumProductionReleaseArtifactTreeBytes + 32 * 1024 * 1024;

/** Maximum accepted JSON receipt published beside one production release archive. */
export const maximumProductionReleaseReceiptBytes = 4 * 1024 * 1024;

/** Digest-bound receipt published beside one immutable production release archive. */
export const productionReleaseArtifactReceiptSchema = v.strictObject({
    archive: v.strictObject({
        bytes: v.pipe(
            v.number(),
            v.safeInteger(),
            v.minValue(1),
            v.maxValue(maximumProductionReleaseArchiveBytes)
        ),
        name: v.literal("release.tar"),
        sha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    }),
    formatVersion: v.literal(1),
    releaseId: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
    releaseManifestSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    runtime: v.strictObject({
        revision: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
        version: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
});

export type ProductionReleaseArtifactReceipt = Readonly<
    v.InferOutput<typeof productionReleaseArtifactReceiptSchema>
>;
