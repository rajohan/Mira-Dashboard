import * as v from "valibot";

import {
    fullCommitShaSchema,
    lowercaseSha256Schema,
    nonnegativeSafeIntegerSchema,
} from "./validation.ts";

const invalidDescriptor = "Production release descriptor is invalid";
export const productionReleaseDescriptorFileName = "release-descriptor.json";
export const maximumProductionReleaseDescriptorBytes = 4 * 1024 * 1024;
export const maximumProductionReleaseDescriptorArtifacts = 4097;

const canonicalRelativePathSchema = v.pipe(
    v.string(invalidDescriptor),
    v.minLength(1, invalidDescriptor),
    v.maxLength(4096, invalidDescriptor),
    v.check((value) => {
        if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) {
            return false;
        }
        return value
            .split("/")
            .every(
                (segment) =>
                    segment.length > 0 &&
                    segment !== "." &&
                    segment !== ".." &&
                    /^[A-Za-z0-9.@_+-]+$/u.test(segment)
            );
    }, invalidDescriptor)
);

const artifactSchema = v.strictObject({
    bytes: nonnegativeSafeIntegerSchema(invalidDescriptor),
    path: canonicalRelativePathSchema,
    sha256: lowercaseSha256Schema(invalidDescriptor),
});

const executableSchema = v.strictObject({
    bytes: nonnegativeSafeIntegerSchema(invalidDescriptor),
    path: canonicalRelativePathSchema,
    sha256: lowercaseSha256Schema(invalidDescriptor),
});

export const productionReleaseDescriptorSchema = v.strictObject({
    artifacts: v.pipe(
        v.array(artifactSchema),
        v.minLength(1, invalidDescriptor),
        v.maxLength(maximumProductionReleaseDescriptorArtifacts, invalidDescriptor),
        v.check(
            (artifacts) =>
                artifacts.every(
                    (artifact, index) =>
                        index === 0 || artifacts[index - 1]!.path < artifact.path
                ),
            invalidDescriptor
        ),
        v.readonly()
    ),
    deliveryExecutor: executableSchema,
    formatVersion: v.literal(1, invalidDescriptor),
    releaseId: fullCommitShaSchema(invalidDescriptor),
    runtime: v.strictObject({
        executable: executableSchema,
        revision: fullCommitShaSchema(invalidDescriptor),
        version: v.pipe(
            v.string(invalidDescriptor),
            v.minLength(1, invalidDescriptor),
            v.maxLength(128, invalidDescriptor),
            v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, invalidDescriptor)
        ),
    }),
});

export type ProductionReleaseDescriptor = Readonly<
    v.InferOutput<typeof productionReleaseDescriptorSchema>
>;

function freezeDescriptor(
    descriptor: v.InferOutput<typeof productionReleaseDescriptorSchema>
): ProductionReleaseDescriptor {
    for (const artifact of descriptor.artifacts) Object.freeze(artifact);
    Object.freeze(descriptor.artifacts);
    Object.freeze(descriptor.deliveryExecutor);
    Object.freeze(descriptor.runtime.executable);
    Object.freeze(descriptor.runtime);
    return Object.freeze(descriptor);
}

export function parseProductionReleaseDescriptor(
    input: unknown
): ProductionReleaseDescriptor {
    const parsed = v.safeParse(productionReleaseDescriptorSchema, input, {
        abortEarly: true,
    });
    if (!parsed.success) throw new TypeError(invalidDescriptor);
    const descriptor = parsed.output;
    const runtimeArtifact = descriptor.artifacts.find(
        ({ path }) => path === descriptor.runtime.executable.path
    );
    const executorArtifact = descriptor.artifacts.find(
        ({ path }) => path === descriptor.deliveryExecutor.path
    );
    if (
        descriptor.runtime.executable.path !== "runtime/bun" ||
        descriptor.deliveryExecutor.path !== "server/productionDelivery.js" ||
        runtimeArtifact?.bytes !== descriptor.runtime.executable.bytes ||
        runtimeArtifact.sha256 !== descriptor.runtime.executable.sha256 ||
        executorArtifact?.bytes !== descriptor.deliveryExecutor.bytes ||
        executorArtifact.sha256 !== descriptor.deliveryExecutor.sha256
    ) {
        throw new TypeError(invalidDescriptor);
    }
    return freezeDescriptor(descriptor);
}

export function serializeProductionReleaseDescriptor(input: unknown): string {
    return `${JSON.stringify(parseProductionReleaseDescriptor(input), undefined, 2)}\n`;
}
