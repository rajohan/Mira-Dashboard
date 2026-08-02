import { isPlainRecord } from "../../../../contracts/runtime.ts";
import type { DatabaseMigrationIdentity } from "../../databaseMigrations/index.ts";
import {
    assertCommitIdentity,
    compareStrings,
    databaseMigrationInventorySha256,
    type DashboardReleaseManifest,
    hasExactKeys,
    isSafeArtifactPath,
    RELEASE_MANIFEST_FORMAT_VERSION,
    REQUIRED_RELEASE_ARTIFACTS,
    type ReleaseManifestArtifact,
    SHA_256_PATTERN,
} from "./manifestPolicy.ts";
import { isBunRuntimeVersion } from "./runtime.ts";
import { MANAGED_DASHBOARD_UNIT_ARTIFACTS } from "./systemdPolicy.ts";

function parseArtifact(value: unknown): ReleaseManifestArtifact {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, ["path", "sha256", "sizeBytes"]) ||
        typeof value.path !== "string" ||
        !isSafeArtifactPath(value.path) ||
        typeof value.sha256 !== "string" ||
        !SHA_256_PATTERN.test(value.sha256) ||
        !Number.isSafeInteger(value.sizeBytes) ||
        (value.sizeBytes as number) < 0
    ) {
        throw new TypeError("Release manifest contains an invalid artifact");
    }
    return {
        path: value.path,
        sha256: value.sha256,
        sizeBytes: value.sizeBytes as number,
    };
}

function parseMigrationIdentity(value: unknown): DatabaseMigrationIdentity {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, ["checksum", "name", "version"]) ||
        !Number.isSafeInteger(value.version) ||
        (value.version as number) <= 0 ||
        typeof value.name !== "string" ||
        !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value.name) ||
        typeof value.checksum !== "string" ||
        !SHA_256_PATTERN.test(value.checksum)
    ) {
        throw new TypeError("Release manifest migration identity is invalid");
    }
    return {
        checksum: value.checksum,
        name: value.name,
        version: value.version as number,
    };
}

function parseSchema(value: unknown): DashboardReleaseManifest["schema"] {
    const expectedKeys = [
        "maximumCompatible",
        "migrations",
        "migrationInventorySha256",
        "migrationRegistrySha256",
        "minimumCompatible",
        "target",
    ];
    if (!isPlainRecord(value) || !hasExactKeys(value, expectedKeys)) {
        throw new TypeError("Release manifest schema declaration is invalid");
    }
    const { maximumCompatible, minimumCompatible, target } = value;
    if (
        !Number.isSafeInteger(maximumCompatible) ||
        !Number.isSafeInteger(minimumCompatible) ||
        !Number.isSafeInteger(target) ||
        (minimumCompatible as number) < 0 ||
        (minimumCompatible as number) > (target as number) ||
        (target as number) > (maximumCompatible as number) ||
        typeof value.migrationRegistrySha256 !== "string" ||
        !SHA_256_PATTERN.test(value.migrationRegistrySha256)
    ) {
        throw new TypeError("Release manifest schema range is invalid");
    }
    const migrations = Array.isArray(value.migrations)
        ? value.migrations.map((migration) => parseMigrationIdentity(migration))
        : undefined;
    // This digest proves only that a foreign manifest is internally consistent.
    // Runtime and release-manager validation bind it to local code and live history.
    if (
        !migrations ||
        migrations.length !== (target as number) ||
        migrations.some((migration, index) => migration.version !== index + 1) ||
        typeof value.migrationInventorySha256 !== "string" ||
        !SHA_256_PATTERN.test(value.migrationInventorySha256) ||
        value.migrationInventorySha256 !== databaseMigrationInventorySha256(migrations)
    ) {
        throw new TypeError("Release manifest migration inventory is invalid");
    }
    return {
        maximumCompatible: maximumCompatible as number,
        migrations,
        migrationInventorySha256: value.migrationInventorySha256,
        migrationRegistrySha256: value.migrationRegistrySha256,
        minimumCompatible: minimumCompatible as number,
        target: target as number,
    };
}

export function parseReleaseManifest(value: unknown): DashboardReleaseManifest {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, [
            "artifacts",
            "builtAt",
            "bunVersion",
            "commitSha",
            "commitShort",
            "commitTitle",
            "components",
            "formatVersion",
            "schema",
        ]) ||
        value.formatVersion !== RELEASE_MANIFEST_FORMAT_VERSION ||
        typeof value.commitSha !== "string" ||
        typeof value.commitShort !== "string" ||
        typeof value.commitTitle !== "string" ||
        typeof value.builtAt !== "string" ||
        typeof value.bunVersion !== "string" ||
        !Array.isArray(value.artifacts) ||
        value.artifacts.length === 0 ||
        value.artifacts.length > 10_000 ||
        !isPlainRecord(value.components) ||
        !hasExactKeys(value.components, ["backendCommit", "frontendCommit"])
    ) {
        throw new TypeError("Release manifest shape is invalid");
    }
    assertCommitIdentity(value.commitSha, value.commitTitle);
    const expectedShortCommit = value.commitSha.slice(0, 8);
    if (
        value.commitShort !== expectedShortCommit ||
        value.components.backendCommit !== expectedShortCommit ||
        value.components.frontendCommit !== expectedShortCommit ||
        Number.isNaN(Date.parse(value.builtAt)) ||
        new Date(value.builtAt).toISOString() !== value.builtAt ||
        !isBunRuntimeVersion(value.bunVersion)
    ) {
        throw new TypeError("Release manifest identity is invalid");
    }

    const artifacts = value.artifacts.map((artifact) => parseArtifact(artifact));
    const artifactPaths = artifacts.map((artifact) => artifact.path);
    const sortedArtifactPaths = artifactPaths.toSorted(compareStrings);
    const managedSystemdArtifactCount = MANAGED_DASHBOARD_UNIT_ARTIFACTS.filter(
        (artifactPath_) => artifactPaths.includes(artifactPath_)
    ).length;
    if (
        new Set(artifactPaths).size !== artifactPaths.length ||
        artifactPaths.some(
            (artifactPath_, index) => artifactPath_ !== sortedArtifactPaths[index]
        ) ||
        REQUIRED_RELEASE_ARTIFACTS.some(
            (requiredPath) => !artifactPaths.includes(requiredPath)
        ) ||
        (managedSystemdArtifactCount !== 0 &&
            managedSystemdArtifactCount !== MANAGED_DASHBOARD_UNIT_ARTIFACTS.length)
    ) {
        throw new TypeError("Release manifest artifact inventory is invalid");
    }

    return {
        artifacts,
        builtAt: value.builtAt,
        bunVersion: value.bunVersion,
        commitSha: value.commitSha,
        commitShort: value.commitShort,
        commitTitle: value.commitTitle,
        components: {
            backendCommit: value.components.backendCommit,
            frontendCommit: value.components.frontendCommit,
        },
        formatVersion: value.formatVersion,
        schema: parseSchema(value.schema),
    };
}
