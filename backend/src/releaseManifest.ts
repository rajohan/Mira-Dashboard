import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { getBackendBuildCommit } from "./buildIdentity.ts";
import { databaseMigrations } from "./databaseMigrations/index.ts";
import { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "./databaseSchemaCompatibility.ts";
import { guardedPath, writeTextNoFollowGuarded } from "./lib/guardedOps.ts";

export { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "./databaseSchemaCompatibility.ts";

export const RELEASE_MANIFEST_FILE_NAME = "release-manifest.json";
export const RELEASE_MANIFEST_FORMAT_VERSION = 1;

const MAX_RELEASE_MANIFEST_BYTES = 256 * 1024;
const RELEASE_ARTIFACT_DIRECTORIES = ["dist", "backend/dist"] as const;
const RELEASE_STATIC_ARTIFACTS = [
    "backend/bun.lock",
    "backend/package.json",
    "bun.lock",
    "package.json",
] as const;
const REQUIRED_RELEASE_ARTIFACTS = [
    ...RELEASE_STATIC_ARTIFACTS,
    "backend/dist/build-identity.json",
    "backend/dist/databasePreflight.js",
    "backend/dist/resetDashboardPassword.js",
    "backend/dist/serverStart.js",
    "backend/dist/workerStart.js",
    "dist/build-identity.json",
    "dist/index.html",
] as const;
const MAX_BUILD_IDENTITY_BYTES = 4096;
const SHA_256_PATTERN = /^[\da-f]{64}$/u;
const COMMIT_SHA_PATTERN = /^[\da-f]{40}$/u;

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
    formatVersion: 1;
    schema: {
        maximumCompatible: number;
        migrationRegistrySha256: string;
        minimumCompatible: number;
        target: number;
    };
}

export interface RuntimeReleaseIdentity {
    artifactCount?: number;
    backendCommit: string;
    commitSha?: string;
    frontendCommit: string;
    issue?: "manifest-code-mismatch" | "manifest-invalid" | "manifest-missing";
    manifestFormatVersion?: number;
    ready: boolean;
    schema?: DashboardReleaseManifest["schema"];
    source: "git" | "manifest" | "unknown";
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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

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
        RELEASE_STATIC_ARTIFACTS.includes(
            value as (typeof RELEASE_STATIC_ARTIFACTS)[number]
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
    for (const build of [backendBuild, frontendBuild]) {
        if (build.commitSha !== commitSha || build.bunVersion !== bunVersion) {
            throw new Error(
                `${build.component} build identity does not match the release source`
            );
        }
    }

    const artifactPaths = await listReleaseArtifactPaths(releaseRoot);
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

function parseSchema(value: unknown): DashboardReleaseManifest["schema"] {
    if (
        !isPlainRecord(value) ||
        !hasExactKeys(value, [
            "maximumCompatible",
            "migrationRegistrySha256",
            "minimumCompatible",
            "target",
        ])
    ) {
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
    return {
        maximumCompatible: maximumCompatible as number,
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
            backendCommit: value.components.backendCommit as string,
            frontendCommit: value.components.frontendCommit as string,
        },
        formatVersion: RELEASE_MANIFEST_FORMAT_VERSION,
        schema: parseSchema(value.schema),
    };
}

export async function writeReleaseManifest(
    options: CreateReleaseManifestOptions
): Promise<DashboardReleaseManifest> {
    const releaseRoot = await fsp.realpath(options.releaseRoot);
    const manifest = await createReleaseManifest({ ...options, releaseRoot });
    await writeTextNoFollowGuarded(
        guardedPath(path.join(releaseRoot, RELEASE_MANIFEST_FILE_NAME)),
        `${JSON.stringify(manifest, undefined, 2)}\n`,
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
        // eslint-disable-next-line unicorn/consistent-json-file-read -- The pinned no-follow descriptor must remain the read target.
        const serialized = await file.readFile("utf8");
        return parseReleaseManifest(JSON.parse(serialized) as unknown);
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
    const configured = process.env.MIRA_DASHBOARD_RELEASE_ROOT?.trim();
    const candidate = configured
        ? path.resolve(configured)
        : path.basename(process.cwd()) === "backend"
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

export async function loadRuntimeReleaseIdentity(
    releaseRoot = PROCESS_RELEASE_ROOT,
    environment = process.env.NODE_ENV,
    backendBuildCommit = getBackendBuildCommit()
): Promise<RuntimeReleaseIdentity> {
    try {
        const manifest = await loadReleaseManifest(releaseRoot);
        await verifyReleaseArtifacts(releaseRoot, manifest);
        const isManifestMatchesCode =
            manifest.commitSha === backendBuildCommit &&
            manifest.bunVersion === Bun.version &&
            manifest.schema.target === DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.target &&
            manifest.schema.minimumCompatible ===
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.minimum &&
            manifest.schema.maximumCompatible ===
                DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY.maximum &&
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
        const commit = fallbackGitCommit(releaseRoot);
        const isMissing = (error as NodeJS.ErrnoException).code === "ENOENT";
        const isDevelopmentFallback = environment !== "production" && isMissing;
        return {
            backendCommit: commit,
            frontendCommit: commit,
            ...(!isDevelopmentFallback && {
                issue: isMissing
                    ? ("manifest-missing" as const)
                    : ("manifest-invalid" as const),
            }),
            ready: isDevelopmentFallback,
            source: commit === "unknown" ? "unknown" : "git",
        };
    }
}

export function getRuntimeReleaseIdentity(
    releaseRoot = PROCESS_RELEASE_ROOT,
    environment = process.env.NODE_ENV,
    backendBuildCommit = getBackendBuildCommit()
): Promise<RuntimeReleaseIdentity> {
    return loadRuntimeReleaseIdentity(releaseRoot, environment, backendBuildCommit);
}
