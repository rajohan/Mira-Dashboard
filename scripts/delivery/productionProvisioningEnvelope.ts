import path from "node:path";

import * as v from "valibot";

import {
    parseProductionReleaseDescriptor,
    productionReleaseDescriptorFileName,
} from "../../src/shared/productionReleaseDescriptor.ts";
import { readBoundedUtf8RegularFile } from "../files/boundedFile.ts";
import {
    inventoryReleaseArtifactTree,
    maximumReleaseArtifactCount,
    type ReleaseArtifactInventoryRecord,
} from "./releaseArtifactInventory.ts";

const failureMessage = "Production provisioning envelope is invalid";
const maximumDescriptorBytes = 4 * 1024 * 1024;
const stableCandidatePaths = Object.freeze([
    "runtime/bun",
    "server/productionProvisioning.js",
] as const);

export const productionProvisioningReceiptEnvelopeSchema = v.object({
    archive: v.object({
        bytes: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
        name: v.literal("release.tar"),
        sha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    }),
    releaseId: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
    releaseDescriptorSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    releaseManifestSha256: v.pipe(v.string(), v.regex(/^[a-f\d]{64}$/u)),
    runtime: v.object({
        revision: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
        version: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
});

export type ProductionProvisioningEnvelope = Readonly<{
    artifacts: readonly ReleaseArtifactInventoryRecord[];
    releaseId: string;
    runtime: Readonly<{ revision: string; version: string }>;
}>;
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
        const descriptorFile = await readBoundedUtf8RegularFile(
            path.join(releaseRoot, productionReleaseDescriptorFileName),
            releaseRoot,
            maximumDescriptorBytes,
            failureMessage,
            failureMessage
        );
        const descriptor = parseProductionReleaseDescriptor(
            JSON.parse(descriptorFile.text) as unknown
        );
        const completeInventory = await inventoryReleaseArtifactTree(releaseRoot);
        const observed = completeInventory.filter(
            ({ path: artifactPath }) =>
                artifactPath !== productionReleaseDescriptorFileName
        );
        if (
            descriptor.artifacts.length > maximumReleaseArtifactCount + 1 ||
            completeInventory.length !== observed.length + 1 ||
            !sameArtifacts(descriptor.artifacts, observed) ||
            stableCandidatePaths.some(
                (requiredPath) =>
                    !observed.some(
                        ({ path: artifactPath }) => artifactPath === requiredPath
                    )
            )
        ) {
            throw failure();
        }
        return Object.freeze({
            artifacts: descriptor.artifacts,
            releaseId: descriptor.releaseId,
            runtime: Object.freeze({
                revision: descriptor.runtime.revision,
                version: descriptor.runtime.version,
            }),
        });
    } catch {
        throw failure();
    }
}
