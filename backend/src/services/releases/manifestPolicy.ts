import { createHash } from "node:crypto";
import path from "node:path";

import type { RuntimeReleaseIdentity } from "../../../../contracts/health.ts";
import {
    databaseMigrationIdentities,
    type DatabaseMigrationIdentity,
    databaseMigrations,
} from "../../databaseMigrations/index.ts";
import {
    MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT,
    MANAGED_DASHBOARD_UNIT_ARTIFACTS,
} from "./systemdPolicy.ts";

export const RELEASE_MANIFEST_FILE_NAME = "release-manifest.json";
export const RELEASE_MANIFEST_FORMAT_VERSION = 2;
export const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
export const RELEASE_ARTIFACT_DIRECTORIES = ["dist", "backend/dist"] as const;
export const RELEASE_STATIC_ARTIFACTS = [
    "backend/config/log-rotation.json",
    "bun.lock",
    "package.json",
    MANAGED_DASHBOARD_RUNTIME_LAUNCHER_ARTIFACT,
] as const;
export const OPTIONAL_RELEASE_STATIC_ARTIFACTS = [
    ...MANAGED_DASHBOARD_UNIT_ARTIFACTS,
] as const;
export const SAFE_RELEASE_STATIC_ARTIFACTS = [
    ...RELEASE_STATIC_ARTIFACTS,
    ...OPTIONAL_RELEASE_STATIC_ARTIFACTS,
] as const;
export const REQUIRED_RELEASE_ARTIFACTS = [
    ...RELEASE_STATIC_ARTIFACTS,
    "backend/dist/build-identity.json",
    "backend/dist/databasePreflight.js",
    "backend/dist/pullRequestPreviewGatewayProxy.js",
    "backend/dist/releaseLifecycle.js",
    "backend/dist/resetDashboardPassword.js",
    "backend/dist/serverStart.js",
    "backend/dist/workerStart.js",
    "dist/build-identity.json",
    "dist/index.html",
] as const;
export const MAX_BUILD_IDENTITY_BYTES = 4096;
export const RUNTIME_RELEASE_VERIFICATION_CACHE_MS = 15_000;
export const SHA_256_PATTERN = /^[\da-f]{64}$/u;
export const COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
export const RUNTIME_COMMIT_PATTERN = /^[\da-f]{8,40}$/u;

export interface ReleaseManifestArtifact {
    path: string;
    sha256: string;
    sizeBytes: number;
}

export interface DashboardReleaseManifest {
    artifacts: ReleaseManifestArtifact[];
    builtAt: string;
    bunVersion: string;
    commitSha: string;
    commitShort: string;
    commitTitle: string;
    components: {
        backendCommit: string;
        frontendCommit: string;
    };
    formatVersion: 2;
    schema: {
        maximumCompatible: number;
        migrations: DatabaseMigrationIdentity[];
        migrationInventorySha256: string;
        migrationRegistrySha256: string;
        minimumCompatible: number;
        target: number;
    };
}

export function requireRunnableReleaseCommit(
    release: RuntimeReleaseIdentity,
    runtimeLabel: string,
    environment = process.env.NODE_ENV
): string {
    if (environment === "production" && !release.ready) {
        throw new Error(
            `${runtimeLabel} release identity is not ready (${release.issue ?? release.source})`
        );
    }
    const releaseCommit = release.commitSha ?? release.backendCommit;
    if (!RUNTIME_COMMIT_PATTERN.test(releaseCommit)) {
        throw new Error(
            `${runtimeLabel} release identity does not contain a valid commit`
        );
    }
    return releaseCommit;
}

export interface CreateReleaseManifestOptions {
    builtAt?: Date;
    bunVersion?: string;
    commitSha?: string;
    commitTitle?: string;
    releaseRoot: string;
}

export interface ComponentBuildIdentity {
    bunVersion: string;
    commitSha: string;
    component: "backend" | "frontend";
    formatVersion: 1;
}

export function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

export function hasExactKeys(
    record: Record<string, unknown>,
    expected: string[]
): boolean {
    const actual = Object.keys(record).toSorted(compareStrings);
    const sortedExpected = expected.toSorted(compareStrings);
    return (
        actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index])
    );
}

export function sha256(value: Uint8Array | string): string {
    return createHash("sha256").update(value).digest("hex");
}

export function databaseMigrationRegistrySha256(): string {
    const serialized = databaseMigrations
        .map((migration) => `${migration.version}\0${migration.name}\0${migration.sql}`)
        .join("\0");
    return sha256(serialized);
}

export function databaseMigrationInventorySha256(
    migrations: readonly DatabaseMigrationIdentity[] = databaseMigrationIdentities()
): string {
    const serialized = migrations
        .map(
            (migration) =>
                `${migration.version}\0${migration.name}\0${migration.checksum}`
        )
        .join("\0");
    return sha256(serialized);
}

export function isSafeArtifactPath(value: string): boolean {
    if (
        !value ||
        value.includes("\\") ||
        value.includes("\0") ||
        path.posix.isAbsolute(value) ||
        path.posix.normalize(value) !== value
    ) {
        return false;
    }
    const parts = value.split("/");
    if (parts.some((part) => !part || part === "." || part === "..")) {
        return false;
    }
    return (
        SAFE_RELEASE_STATIC_ARTIFACTS.includes(
            value as (typeof SAFE_RELEASE_STATIC_ARTIFACTS)[number]
        ) ||
        RELEASE_ARTIFACT_DIRECTORIES.some((directory) =>
            value.startsWith(`${directory}/`)
        )
    );
}

export function assertCommitIdentity(commitSha: string, commitTitle: string): void {
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
        throw new TypeError("Release commit must be a full lowercase Git SHA");
    }
    if (!commitTitle || commitTitle.length > 500 || commitTitle.includes("\0")) {
        throw new TypeError("Release commit title is invalid");
    }
}
