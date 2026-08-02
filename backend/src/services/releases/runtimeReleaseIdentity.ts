import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { RuntimeReleaseIdentity } from "../../../../contracts/health.ts";
import { getBackendBuildCommit } from "../../buildIdentity.ts";
import { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "../../databaseSchemaCompatibility.ts";
import { createStructuredLogger } from "../../lib/structuredLogger.ts";
import {
    gitOutput,
    loadReleaseManifest,
    verifyReleaseArtifacts,
    verifyReleaseBuildIdentities,
} from "./manifestArtifacts.ts";
import {
    databaseMigrationInventorySha256,
    databaseMigrationRegistrySha256,
    RUNTIME_RELEASE_VERIFICATION_CACHE_MS,
} from "./manifestPolicy.ts";
import { isCurrentBunRuntime } from "./runtime.ts";

const logger = createStructuredLogger("release-manifest");

interface RuntimeReleaseIdentityCache {
    expiresAt: number;
    key: string;
    promise: Promise<RuntimeReleaseIdentity>;
}

const runtimeReleaseIdentityCacheState: {
    entry?: RuntimeReleaseIdentityCache;
} = {};

function inferProcessReleaseRoot(): string {
    const candidate =
        path.basename(process.cwd()) === "backend"
            ? path.dirname(process.cwd())
            : path.resolve(import.meta.dirname, "..", "..");
    try {
        return fs.realpathSync(candidate);
    } catch {
        return candidate;
    }
}

const PROCESS_RELEASE_ROOT = inferProcessReleaseRoot();

export function getProcessReleaseRoot(): string {
    return PROCESS_RELEASE_ROOT;
}

function fallbackGitCommit(releaseRoot: string): string {
    try {
        const value = gitOutput(releaseRoot, ["rev-parse", "--short=8", "HEAD"]);
        return /^[\da-f]{8}$/u.test(value) ? value : "unknown";
    } catch {
        return "unknown";
    }
}

function developmentRuntimeReleaseIdentity(releaseRoot: string): RuntimeReleaseIdentity {
    const commit = fallbackGitCommit(releaseRoot);
    return {
        backendCommit: commit,
        frontendCommit: commit,
        ready: true,
        source: commit === "unknown" ? "unknown" : "git",
    };
}

export async function loadRuntimeReleaseIdentity(
    releaseRoot = PROCESS_RELEASE_ROOT,
    environment = process.env.NODE_ENV,
    backendBuildCommit = getBackendBuildCommit()
): Promise<RuntimeReleaseIdentity> {
    if (environment !== "production" && backendBuildCommit === "development") {
        return developmentRuntimeReleaseIdentity(releaseRoot);
    }
    let isLoadingManifest = true;
    try {
        const realReleaseRoot = await fsp.realpath(releaseRoot);
        const manifest = await loadReleaseManifest(realReleaseRoot);
        isLoadingManifest = false;
        await verifyReleaseArtifacts(realReleaseRoot, manifest);
        try {
            await verifyReleaseBuildIdentities(realReleaseRoot, manifest);
        } catch (error) {
            logger.warn("release_manifest.build_identity_verification_failed", {
                error,
            });
            return {
                artifactCount: manifest.artifacts.length,
                backendCommit: manifest.components.backendCommit,
                commitSha: manifest.commitSha,
                frontendCommit: manifest.components.frontendCommit,
                issue: "build-identity-invalid",
                manifestFormatVersion: manifest.formatVersion,
                ready: false,
                schema: manifest.schema,
                source: "manifest",
            };
        }
        const isManifestMatchesCode =
            manifest.commitSha === backendBuildCommit &&
            isCurrentBunRuntime(manifest.bunVersion) &&
            manifest.schema.target === DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target &&
            manifest.schema.minimumCompatible ===
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum &&
            manifest.schema.maximumCompatible ===
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum &&
            manifest.schema.migrationInventorySha256 ===
                databaseMigrationInventorySha256() &&
            manifest.schema.migrationRegistrySha256 === databaseMigrationRegistrySha256();
        return {
            artifactCount: manifest.artifacts.length,
            backendCommit: manifest.components.backendCommit,
            commitSha: manifest.commitSha,
            frontendCommit: manifest.components.frontendCommit,
            ...(!isManifestMatchesCode && {
                issue: "manifest-code-mismatch" as const,
            }),
            manifestFormatVersion: manifest.formatVersion,
            ready: isManifestMatchesCode,
            schema: manifest.schema,
            source: "manifest",
        };
    } catch (error) {
        const isManifestMissing =
            isLoadingManifest && (error as NodeJS.ErrnoException).code === "ENOENT";
        const isDevelopmentFallback = environment !== "production" && isManifestMissing;
        if (isDevelopmentFallback) {
            return developmentRuntimeReleaseIdentity(releaseRoot);
        }
        const commit = fallbackGitCommit(releaseRoot);
        return {
            backendCommit: commit,
            frontendCommit: commit,
            issue: isManifestMissing
                ? ("manifest-missing" as const)
                : ("manifest-invalid" as const),
            ready: false,
            source: commit === "unknown" ? "unknown" : "git",
        };
    }
}

export function getRuntimeReleaseIdentity(
    releaseRoot = PROCESS_RELEASE_ROOT,
    environment = process.env.NODE_ENV,
    backendBuildCommit = getBackendBuildCommit()
): Promise<RuntimeReleaseIdentity> {
    const key = JSON.stringify([releaseRoot, environment, backendBuildCommit]);
    const now = Date.now();
    if (
        runtimeReleaseIdentityCacheState.entry?.key === key &&
        runtimeReleaseIdentityCacheState.entry.expiresAt > now
    ) {
        return runtimeReleaseIdentityCacheState.entry.promise;
    }

    const promise = loadRuntimeReleaseIdentity(
        releaseRoot,
        environment,
        backendBuildCommit
    );
    const cacheEntry: RuntimeReleaseIdentityCache = {
        // Concurrent probes share the in-flight verification. The bounded TTL
        // begins only after the complete artifact scan settles.
        expiresAt: Infinity,
        key,
        promise,
    };
    runtimeReleaseIdentityCacheState.entry = cacheEntry;
    void (async () => {
        try {
            await promise;
            if (runtimeReleaseIdentityCacheState.entry === cacheEntry) {
                cacheEntry.expiresAt = Date.now() + RUNTIME_RELEASE_VERIFICATION_CACHE_MS;
            }
        } catch {
            if (runtimeReleaseIdentityCacheState.entry === cacheEntry) {
                runtimeReleaseIdentityCacheState.entry = undefined;
            }
        }
    })();
    return promise;
}

export function invalidateRuntimeReleaseIdentityCache(): void {
    runtimeReleaseIdentityCacheState.entry = undefined;
}
