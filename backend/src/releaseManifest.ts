import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import type { RuntimeReleaseIdentity } from "../../contracts/health.ts";
import { isPlainRecord } from "../../contracts/runtime.ts";
import { getBackendBuildCommit } from "./buildIdentity.ts";
import {
    databaseMigrationIdentities,
    type DatabaseMigrationIdentity,
    databaseMigrations,
} from "./databaseMigrations/index.ts";
import { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "./databaseSchemaCompatibility.ts";
import { guardedPath, writeTextNoFollowGuarded } from "./lib/guardedOps.ts";
import { createStructuredLogger } from "./lib/structuredLogger.ts";

export { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "./databaseSchemaCompatibility.ts";

export const RELEASE_MANIFEST_FILE_NAME = "release-manifest.json";
export const RELEASE_MANIFEST_FORMAT_VERSION = 2;
const logger = createStructuredLogger("release-manifest");

const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
const RELEASE_ARTIFACT_DIRECTORIES = ["dist", "backend/dist"] as const;
const RELEASE_STATIC_ARTIFACTS = [
    "backend/config/log-rotation.json",
    "bun.lock",
    "package.json",
] as const;
// Keep the immediately previous pre-root-workspace release verifiable for
// rollback. Remove this allowlist after both managed slots were built from the
// consolidated root package.
const PRE_ROOT_WORKSPACE_RELEASE_ARTIFACTS = [
    "backend/bun.lock",
    "backend/package.json",
] as const;
const SAFE_RELEASE_STATIC_ARTIFACTS = [
    ...RELEASE_STATIC_ARTIFACTS,
    ...PRE_ROOT_WORKSPACE_RELEASE_ARTIFACTS,
] as const;
const REQUIRED_RELEASE_ARTIFACTS = [
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
const MAX_BUILD_IDENTITY_BYTES = 4096;
const RUNTIME_RELEASE_VERIFICATION_CACHE_MS = 15_000;
const SHA_256_PATTERN = /^[\da-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;
const RUNTIME_COMMIT_PATTERN = /^[\da-f]{8,40}$/u;

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

interface CreateReleaseManifestOptions {
    builtAt?: Date;
    bunVersion?: string;
    commitSha?: string;
    commitTitle?: string;
    releaseRoot: string;
}

interface ComponentBuildIdentity {
    bunVersion: string;
    commitSha: string;
    component: "backend" | "frontend";
    formatVersion: 1;
}

interface RuntimeReleaseIdentityCache {
    expiresAt: number;
    key: string;
    promise: Promise<RuntimeReleaseIdentity>;
}

const runtimeReleaseIdentityCacheState: {
    entry?: RuntimeReleaseIdentityCache;
} = {};

function compareStrings(left: string, right: string): number {
    return left.localeCompare(right);
}

function hasExactKeys(record: Record<string, unknown>, expected: string[]): boolean {
    const actual = Object.keys(record).toSorted(compareStrings);
    const sortedExpected = expected.toSorted(compareStrings);
    return (
        actual.length === sortedExpected.length &&
        actual.every((key, index) => key === sortedExpected[index])
    );
}

function sha256(value: Uint8Array | string): string {
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

function isSafeArtifactPath(value: string): boolean {
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

function artifactPath(releaseRoot: string, relativePath: string): string {
    if (!isSafeArtifactPath(relativePath)) {
        throw new TypeError(`Invalid release artifact path: ${relativePath}`);
    }
    return path.join(releaseRoot, ...relativePath.split("/"));
}

async function assertArtifactAncestorsReal(
    releaseRoot: string,
    relativePath: string,
    shouldIncludeLeaf = false
): Promise<void> {
    const segments = relativePath.split("/");
    const directorySegments = shouldIncludeLeaf ? segments : segments.slice(0, -1);
    let currentPath = releaseRoot;
    for (const segment of directorySegments) {
        currentPath = path.join(currentPath, segment);
        const stat = await fsp.lstat(currentPath);
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
            throw new TypeError(
                `Release artifact path must not traverse symlinks: ${relativePath}`
            );
        }
    }
}

async function readRegularFileNoFollow(filePath: string): Promise<Buffer> {
    const file = await fsp.open(
        filePath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1) {
            throw new TypeError("Release artifacts must be single-link regular files");
        }
        return await file.readFile();
    } finally {
        await file.close();
    }
}

async function collectArtifactDirectory(
    releaseRoot: string,
    relativeDirectory: string
): Promise<string[]> {
    await assertArtifactAncestorsReal(releaseRoot, relativeDirectory, true);
    const absoluteDirectory = artifactPath(
        releaseRoot,
        `${relativeDirectory}/placeholder`
    );
    const directoryPath = path.dirname(absoluteDirectory);
    const directoryStat = await fsp.lstat(directoryPath);
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
        throw new TypeError(
            `Release artifact directory must be a real directory: ${relativeDirectory}`
        );
    }

    const artifacts: string[] = [];
    const visit = async (absolute: string, relative: string): Promise<void> => {
        const entries = await fsp.readdir(absolute, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isSymbolicLink()) {
                throw new TypeError(
                    `Release artifact tree must not contain symlinks: ${relative}/${entry.name}`
                );
            }
            const childAbsolute = path.join(absolute, entry.name);
            const childRelative = `${relative}/${entry.name}`;
            if (entry.isDirectory()) {
                await visit(childAbsolute, childRelative);
            } else if (entry.isFile()) {
                artifacts.push(childRelative);
            } else {
                throw new TypeError(
                    `Release artifact tree must contain only files and directories: ${childRelative}`
                );
            }
        }
    };

    await visit(directoryPath, relativeDirectory);
    return artifacts;
}

export async function listReleaseArtifactPaths(releaseRoot: string): Promise<string[]> {
    const realReleaseRoot = await fsp.realpath(releaseRoot);
    const rootStat = await fsp.lstat(realReleaseRoot);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new TypeError("Release root must resolve to a real directory");
    }

    const paths: string[] = [...RELEASE_STATIC_ARTIFACTS];
    for (const directory of RELEASE_ARTIFACT_DIRECTORIES) {
        paths.push(...(await collectArtifactDirectory(realReleaseRoot, directory)));
    }
    return paths.toSorted(compareStrings);
}

async function releaseArtifact(
    releaseRoot: string,
    relativePath: string
): Promise<ReleaseManifestArtifact> {
    await assertArtifactAncestorsReal(releaseRoot, relativePath);
    const content = await readRegularFileNoFollow(
        artifactPath(releaseRoot, relativePath)
    );
    return {
        path: relativePath,
        sha256: sha256(content),
        sizeBytes: content.byteLength,
    };
}

function gitOutput(releaseRoot: string, arguments_: string[]): string {
    const result = Bun.spawnSync({
        cmd: ["git", "-C", releaseRoot, ...arguments_],
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
    });
    if (result.exitCode !== 0) {
        throw new Error(`Git release identity command failed: ${arguments_.join(" ")}`);
    }
    return new TextDecoder().decode(result.stdout).trim();
}

function assertGitReleaseSourceClean(releaseRoot: string): void {
    const status = gitOutput(releaseRoot, [
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
    ]);
    if (status) {
        throw new Error("Release source contains uncommitted changes");
    }
}

function assertCommitIdentity(commitSha: string, commitTitle: string): void {
    if (!COMMIT_SHA_PATTERN.test(commitSha)) {
        throw new TypeError("Release commit must be a full lowercase Git SHA");
    }
    if (!commitTitle || commitTitle.length > 500 || commitTitle.includes("\0")) {
        throw new TypeError("Release commit title is invalid");
    }
}

async function loadComponentBuildIdentity(
    releaseRoot: string,
    component: ComponentBuildIdentity["component"]
): Promise<ComponentBuildIdentity> {
    const relativePath =
        component === "backend"
            ? "backend/dist/build-identity.json"
            : "dist/build-identity.json";
    await assertArtifactAncestorsReal(releaseRoot, relativePath);
    const content = await readRegularFileNoFollow(
        artifactPath(releaseRoot, relativePath)
    );
    if (content.byteLength === 0 || content.byteLength > MAX_BUILD_IDENTITY_BYTES) {
        throw new TypeError(`${component} build identity must be a bounded file`);
    }
    const value = JSON.parse(content.toString("utf8")) as unknown;
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, ["bunVersion", "commitSha", "component", "formatVersion"]) ||
        value.component !== component ||
        value.formatVersion !== 1 ||
        typeof value.commitSha !== "string" ||
        !COMMIT_SHA_PATTERN.test(value.commitSha) ||
        typeof value.bunVersion !== "string" ||
        !value.bunVersion ||
        value.bunVersion.length > 64
    ) {
        throw new TypeError(`${component} build identity is invalid`);
    }
    return {
        bunVersion: value.bunVersion,
        commitSha: value.commitSha,
        component,
        formatVersion: 1,
    };
}

function assertComponentBuildIdentities(
    builds: ComponentBuildIdentity[],
    commitSha: string,
    bunVersion: string,
    expectedIdentity: "release manifest" | "release source"
): void {
    for (const build of builds) {
        if (build.commitSha !== commitSha || build.bunVersion !== bunVersion) {
            throw new Error(
                `${build.component} build identity does not match the ${expectedIdentity}`
            );
        }
    }
}

export async function verifyReleaseBuildIdentities(
    releaseRoot: string,
    manifest: DashboardReleaseManifest
): Promise<void> {
    const realReleaseRoot = await fsp.realpath(releaseRoot);
    const builds = await Promise.all([
        loadComponentBuildIdentity(realReleaseRoot, "backend"),
        loadComponentBuildIdentity(realReleaseRoot, "frontend"),
    ]);
    assertComponentBuildIdentities(
        builds,
        manifest.commitSha,
        manifest.bunVersion,
        "release manifest"
    );
}

export async function createReleaseManifest(
    options: CreateReleaseManifestOptions
): Promise<DashboardReleaseManifest> {
    const releaseRoot = await fsp.realpath(options.releaseRoot);
    if (options.commitSha === undefined || options.commitTitle === undefined) {
        assertGitReleaseSourceClean(releaseRoot);
    }
    const commitSha = options.commitSha ?? gitOutput(releaseRoot, ["rev-parse", "HEAD"]);
    const commitTitle =
        options.commitTitle ?? gitOutput(releaseRoot, ["log", "-1", "--pretty=%s"]);
    assertCommitIdentity(commitSha, commitTitle);
    const bunVersion = options.bunVersion ?? Bun.version;
    const [backendBuild, frontendBuild] = await Promise.all([
        loadComponentBuildIdentity(releaseRoot, "backend"),
        loadComponentBuildIdentity(releaseRoot, "frontend"),
    ]);
    assertComponentBuildIdentities(
        [backendBuild, frontendBuild],
        commitSha,
        bunVersion,
        "release source"
    );

    const artifactPaths = await listReleaseArtifactPaths(releaseRoot);
    if (
        REQUIRED_RELEASE_ARTIFACTS.some(
            (requiredPath) => !artifactPaths.includes(requiredPath)
        )
    ) {
        throw new TypeError("Release manifest artifact inventory is invalid");
    }
    const artifacts: ReleaseManifestArtifact[] = [];
    for (const relativePath of artifactPaths) {
        artifacts.push(await releaseArtifact(releaseRoot, relativePath));
    }
    const commitShort = commitSha.slice(0, 8);
    const manifest: DashboardReleaseManifest = {
        artifacts,
        builtAt: (options.builtAt ?? new Date()).toISOString(),
        bunVersion,
        commitSha,
        commitShort,
        commitTitle,
        components: {
            backendCommit: commitShort,
            frontendCommit: commitShort,
        },
        formatVersion: RELEASE_MANIFEST_FORMAT_VERSION,
        schema: {
            maximumCompatible: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum,
            migrations: databaseMigrationIdentities(),
            migrationInventorySha256: databaseMigrationInventorySha256(),
            migrationRegistrySha256: databaseMigrationRegistrySha256(),
            minimumCompatible: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum,
            target: DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target,
        },
    };
    return parseReleaseManifest(manifest);
}

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
        !value.bunVersion ||
        value.bunVersion.length > 64
    ) {
        throw new TypeError("Release manifest identity is invalid");
    }

    const artifacts = value.artifacts.map((artifact) => parseArtifact(artifact));
    const artifactPaths = artifacts.map((artifact) => artifact.path);
    const sortedArtifactPaths = artifactPaths.toSorted(compareStrings);
    if (
        new Set(artifactPaths).size !== artifactPaths.length ||
        artifactPaths.some(
            (artifactPath_, index) => artifactPath_ !== sortedArtifactPaths[index]
        ) ||
        REQUIRED_RELEASE_ARTIFACTS.some(
            (requiredPath) => !artifactPaths.includes(requiredPath)
        )
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

export async function writeReleaseManifest(
    options: CreateReleaseManifestOptions
): Promise<DashboardReleaseManifest> {
    const releaseRoot = await fsp.realpath(options.releaseRoot);
    const manifest = await createReleaseManifest({ ...options, releaseRoot });
    const serialized = `${JSON.stringify(manifest, undefined, 2)}\n`;
    if (Buffer.byteLength(serialized) > MAX_RELEASE_MANIFEST_BYTES) {
        throw new TypeError("Release manifest must be a bounded regular file");
    }
    await writeTextNoFollowGuarded(
        guardedPath(path.join(releaseRoot, RELEASE_MANIFEST_FILE_NAME)),
        serialized,
        0o644
    );
    return manifest;
}

export async function loadReleaseManifest(
    releaseRoot: string
): Promise<DashboardReleaseManifest> {
    const realReleaseRoot = await fsp.realpath(releaseRoot);
    const manifestPath = path.join(realReleaseRoot, RELEASE_MANIFEST_FILE_NAME);
    const file = await fsp.open(
        manifestPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW
    );
    try {
        const stat = await file.stat();
        if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size === 0 ||
            stat.size > MAX_RELEASE_MANIFEST_BYTES
        ) {
            throw new TypeError("Release manifest must be a bounded regular file");
        }
        const serialized = Buffer.alloc(stat.size);
        const { bytesRead } = await file.read(serialized, 0, stat.size, 0);
        if (bytesRead !== stat.size) {
            throw new TypeError("Release manifest could not be read completely");
        }
        return parseReleaseManifest(JSON.parse(serialized.toString("utf8")) as unknown);
    } finally {
        await file.close();
    }
}

export async function verifyReleaseArtifacts(
    releaseRoot: string,
    manifest: DashboardReleaseManifest
): Promise<void> {
    const realReleaseRoot = await fsp.realpath(releaseRoot);
    const inventory = await listReleaseArtifactPaths(realReleaseRoot);
    const declared = manifest.artifacts.map((artifact) => artifact.path);
    if (
        inventory.length !== declared.length ||
        inventory.some((artifactPath_, index) => artifactPath_ !== declared[index])
    ) {
        throw new Error("Release artifact inventory does not match its manifest");
    }
    for (const artifact of manifest.artifacts) {
        const actual = await releaseArtifact(realReleaseRoot, artifact.path);
        if (
            actual.sha256 !== artifact.sha256 ||
            actual.sizeBytes !== artifact.sizeBytes
        ) {
            throw new Error(`Release artifact verification failed: ${artifact.path}`);
        }
    }
}

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
            manifest.bunVersion === Bun.version &&
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
