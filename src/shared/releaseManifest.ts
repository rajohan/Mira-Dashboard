import * as v from "valibot";

import { timestampMillisecondsSchema } from "./dateTime.ts";
import {
    boundedControlSafeTextSchema,
    fullCommitShaSchema,
    lowercaseSha256Schema,
    noNulStringAction,
    nonnegativeSafeIntegerSchema,
} from "./validation.ts";

const invalidReleaseManifest = "Release manifest is invalid";
const maximumReleaseArtifacts = 4096;
const maximumReleasePackages = 256;
const maximumReleaseMigrations = 64;
const maximumReleaseCommitTitleCharacters = 500;

/** Commands whose successful output is represented by one release manifest. */
export const releaseBuildCommands = Object.freeze([
    "bun run build browser",
    "bun run build processes",
    "bun run check docs",
    "bun run check database",
] as const);

/** Process roles that every production release must contain. */
export const releaseProcessRoles = Object.freeze([
    "production-delivery",
    "web",
    "worker",
] as const);

/** Cross-release production protocols implemented by every immutable release. */
export const releaseDeliveryProtocols = Object.freeze([
    "delivery.production.v3",
] as const);

function boundedToken(maximumLength: number) {
    return v.pipe(
        v.string(invalidReleaseManifest),
        v.minLength(1, invalidReleaseManifest),
        v.maxLength(maximumLength, invalidReleaseManifest),
        noNulStringAction(invalidReleaseManifest),
        v.regex(/^[^\p{Cc}\p{Cf}\s]+$/u, invalidReleaseManifest)
    );
}

function canonicalRelativePathSchema() {
    return v.pipe(
        boundedToken(4096),
        v.check((value) => {
            if (value.startsWith("/") || value.includes("\\")) return false;
            const segments = value.split("/");
            return segments.every(
                (segment) =>
                    segment.length > 0 &&
                    segment !== "." &&
                    segment !== ".." &&
                    /^[A-Za-z0-9.@_+-]+$/u.test(segment)
            );
        }, invalidReleaseManifest)
    );
}

function strictlySortedBy<T>(values: readonly T[], key: (value: T) => string): boolean {
    for (let index = 1; index < values.length; index += 1) {
        if (key(values[index - 1]!) >= key(values[index]!)) return false;
    }
    return true;
}

const releaseArtifactSchema = v.strictObject({
    bytes: nonnegativeSafeIntegerSchema(invalidReleaseManifest),
    path: canonicalRelativePathSchema(),
    sha256: lowercaseSha256Schema(invalidReleaseManifest),
});

const releaseMigrationSchema = v.strictObject({
    id: v.pipe(
        boundedToken(128),
        v.regex(/^\d{14}_[a-z\d][a-z\d_-]*$/u, invalidReleaseManifest)
    ),
    migrationSha256: lowercaseSha256Schema(invalidReleaseManifest),
    snapshotSha256: lowercaseSha256Schema(invalidReleaseManifest),
});

const releasePackageSchema = v.strictObject({
    name: v.pipe(
        boundedToken(214),
        v.regex(
            /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u,
            invalidReleaseManifest
        )
    ),
    scope: v.picklist(["dependency", "devDependency"], invalidReleaseManifest),
    version: boundedToken(256),
});

const releaseBuildCommandTupleSchema = v.tuple(
    releaseBuildCommands.map((command) => v.literal(command))
);
const releaseProcessRoleTupleSchema = v.tuple(
    releaseProcessRoles.map((role) => v.literal(role))
);
const releaseDeliveryProtocolTupleSchema = v.tuple(
    releaseDeliveryProtocols.map((protocol) => v.literal(protocol))
);

const sharedManifestEntries = {
    artifacts: v.pipe(
        v.array(releaseArtifactSchema),
        v.minLength(1, invalidReleaseManifest),
        v.maxLength(maximumReleaseArtifacts, invalidReleaseManifest),
        v.check(
            (artifacts) => strictlySortedBy(artifacts, ({ path }) => path),
            invalidReleaseManifest
        ),
        v.readonly()
    ),
    buildCommands: v.pipe(releaseBuildCommandTupleSchema, v.readonly()),
    documentationSha256: lowercaseSha256Schema(invalidReleaseManifest),
    formatVersion: v.literal(1, invalidReleaseManifest),
    lockfileSha256: lowercaseSha256Schema(invalidReleaseManifest),
    migrations: v.pipe(
        v.array(releaseMigrationSchema),
        v.minLength(1, invalidReleaseManifest),
        v.maxLength(maximumReleaseMigrations, invalidReleaseManifest),
        v.check(
            (migrations) => strictlySortedBy(migrations, ({ id }) => id),
            invalidReleaseManifest
        ),
        v.readonly()
    ),
    packages: v.pipe(
        v.array(releasePackageSchema),
        v.minLength(1, invalidReleaseManifest),
        v.maxLength(maximumReleasePackages, invalidReleaseManifest),
        v.check(
            (packages) => strictlySortedBy(packages, ({ name }) => name),
            invalidReleaseManifest
        ),
        v.readonly()
    ),
    runtime: v.strictObject({
        revision: fullCommitShaSchema(invalidReleaseManifest),
        version: v.pipe(
            v.string(),
            v.maxLength(128, invalidReleaseManifest),
            v.regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u, invalidReleaseManifest)
        ),
    }),
    source: v.strictObject({
        commitSha: fullCommitShaSchema(invalidReleaseManifest),
        treeState: v.literal("clean", invalidReleaseManifest),
    }),
} as const;

const currentReleaseManifestSchema = v.strictObject({
    ...sharedManifestEntries,
    deliveryProtocols: v.pipe(releaseDeliveryProtocolTupleSchema, v.readonly()),
    display: v.strictObject({
        builtAtMs: timestampMillisecondsSchema(invalidReleaseManifest),
        commitTitle: boundedControlSafeTextSchema(
            maximumReleaseCommitTitleCharacters,
            invalidReleaseManifest
        ),
        schemaTarget: nonnegativeSafeIntegerSchema(invalidReleaseManifest),
    }),
    processRoles: v.pipe(releaseProcessRoleTupleSchema, v.readonly()),
});

export type ReleaseManifest = v.InferOutput<typeof currentReleaseManifestSchema>;

/** Strict current release format; historical release shapes are not admitted. */
export const releaseManifestSchema = currentReleaseManifestSchema;

function freezeManifest(manifest: ReleaseManifest): ReleaseManifest {
    Object.freeze(manifest.display);
    Object.freeze(manifest.source);
    Object.freeze(manifest.runtime);
    for (const packageIdentity of manifest.packages) Object.freeze(packageIdentity);
    for (const migration of manifest.migrations) Object.freeze(migration);
    for (const artifact of manifest.artifacts) Object.freeze(artifact);
    Object.freeze(manifest.buildCommands);
    Object.freeze(manifest.deliveryProtocols);
    Object.freeze(manifest.processRoles);
    Object.freeze(manifest.packages);
    Object.freeze(manifest.migrations);
    Object.freeze(manifest.artifacts);
    return Object.freeze(manifest);
}

/**
 * Parses and deeply freezes one untrusted release manifest value.
 * @param input Unknown JSON-compatible manifest candidate.
 * @returns Canonically ordered, immutable release identity.
 */
export function parseReleaseManifest(input: unknown): ReleaseManifest {
    const result = v.safeParse(releaseManifestSchema, input, { abortEarly: true });
    if (!result.success) throw new TypeError(invalidReleaseManifest);
    return freezeManifest(result.output);
}

/**
 * Serializes a validated manifest with deterministic key ordering and one final newline.
 * @param input Parsed or untrusted manifest candidate.
 * @returns Canonical checked-in/artifact representation.
 */
export function serializeReleaseManifest(input: unknown): string {
    const manifest = parseReleaseManifest(input);
    if (
        !manifest.deliveryProtocols.includes("delivery.production.v3") ||
        !manifest.processRoles.includes("production-delivery")
    ) {
        throw new TypeError(invalidReleaseManifest);
    }
    return `${JSON.stringify(manifest, null, 2)}\n`;
}
