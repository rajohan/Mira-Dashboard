import path from "node:path";

import * as v from "valibot";

import { readBoundedUtf8RegularFile } from "../files/boundedFile.ts";
import {
    inventoryReleaseArtifactTree,
    maximumReleaseArtifactCount,
    type ReleaseArtifactInventoryRecord,
} from "./releaseArtifactInventory.ts";

const failureMessage = "Production provisioning envelope is invalid";
const manifestFileName = "release-manifest.json";
const maximumManifestBytes = 4 * 1024 * 1024;
const stableCandidatePaths = Object.freeze([
    "runtime/bun",
    "server/productionProvisioning.js",
] as const);

const canonicalPathSchema = v.pipe(
    v.string(),
    v.minLength(1),
    v.maxLength(4096),
    v.regex(/^(?!\/)(?!.*\\)(?!.*(?:^|\/)\.\.?(?:\/|$))[A-Za-z0-9.@_+/-]+$/u)
);
const artifactSchema = v.object({
    bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    path: canonicalPathSchema,
    sha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
});
const envelopeSchema = v.object({
    artifacts: v.pipe(
        v.array(artifactSchema),
        v.minLength(1),
        v.maxLength(maximumReleaseArtifactCount),
        v.check((artifacts) =>
            artifacts.every(
                ({ path: artifactPath }, index) =>
                    index === 0 ||
                    (artifacts[index - 1]?.path ?? artifactPath) < artifactPath
            )
        )
    ),
    runtime: v.object({
        revision: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
        version: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
    source: v.object({
        commitSha: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
        treeState: v.literal("clean"),
    }),
});

export const productionProvisioningReceiptEnvelopeSchema = v.object({
    archive: v.object({
        bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        name: v.literal("release.tar"),
        sha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    }),
    releaseId: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
    releaseManifestSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    runtime: v.object({
        revision: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
        version: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
});

export type ProductionProvisioningEnvelope = Readonly<
    v.InferOutput<typeof envelopeSchema>
>;
export type ProductionProvisioningReceiptEnvelope = Readonly<
    v.InferOutput<typeof productionProvisioningReceiptEnvelopeSchema>
>;

function failure(): Error {
    return new Error(failureMessage);
}

function sameArtifacts(
    declared: readonly ReleaseArtifactInventoryRecord[],
    observed: readonly ReleaseArtifactInventoryRecord[]
): boolean {
    return (
        declared.length === observed.length &&
        declared.every(
            (record, index) =>
                record.bytes === observed[index]?.bytes &&
                record.path === observed[index]?.path &&
                record.sha256 === observed[index]?.sha256
        )
    );
}

/**
 * Verifies the stable cross-generation handoff envelope only. Candidate-owned code
 * performs the complete current release and privileged-installation validation.
 * @param releaseRoot Immutable candidate release root.
 * @returns The bounded fields needed by the installed dispatcher.
 */
export async function verifyProductionProvisioningEnvelope(
    releaseRoot: string
): Promise<ProductionProvisioningEnvelope> {
    try {
        const manifest = await readBoundedUtf8RegularFile(
            path.join(releaseRoot, manifestFileName),
            releaseRoot,
            maximumManifestBytes,
            failureMessage,
            failureMessage
        );
        const parsed = v.parse(envelopeSchema, JSON.parse(manifest.text) as unknown, {
            abortEarly: true,
        });
        const completeInventory = await inventoryReleaseArtifactTree(releaseRoot);
        const observed = completeInventory.filter(
            ({ path: artifactPath }) => artifactPath !== manifestFileName
        );
        if (
            completeInventory.length !== observed.length + 1 ||
            !sameArtifacts(parsed.artifacts, observed) ||
            stableCandidatePaths.some(
                (requiredPath) =>
                    !observed.some(
                        ({ path: artifactPath }) => artifactPath === requiredPath
                    )
            )
        ) {
            throw failure();
        }
        Object.freeze(parsed.runtime);
        Object.freeze(parsed.source);
        for (const artifact of parsed.artifacts) Object.freeze(artifact);
        Object.freeze(parsed.artifacts);
        return Object.freeze(parsed);
    } catch {
        throw failure();
    }
}
