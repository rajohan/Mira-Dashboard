import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { isPlainRecord } from "../../../../contracts/runtime.ts";
import { databaseMigrationIdentities } from "../../databaseMigrations/index.ts";
import { DASHBOARD_DATABASE_SCHEMA_COMPATIBILITY } from "../../databaseSchemaCompatibility.ts";
import { guardedPath, writeTextNoFollowGuarded } from "../../lib/guardedOps.ts";
import { parseReleaseManifest } from "./manifestParser.ts";
import {
    assertCommitIdentity,
    COMMIT_SHA_PATTERN,
    compareStrings,
    type ComponentBuildIdentity,
    type CreateReleaseManifestOptions,
    databaseMigrationInventorySha256,
    databaseMigrationRegistrySha256,
    type DashboardReleaseManifest,
    hasExactKeys,
    isSafeArtifactPath,
    MAX_BUILD_IDENTITY_BYTES,
    MAX_RELEASE_MANIFEST_BYTES,
    OPTIONAL_RELEASE_STATIC_ARTIFACTS,
    RELEASE_ARTIFACT_DIRECTORIES,
    RELEASE_MANIFEST_FILE_NAME,
    RELEASE_MANIFEST_FORMAT_VERSION,
    RELEASE_STATIC_ARTIFACTS,
    REQUIRED_RELEASE_ARTIFACTS,
    type ReleaseManifestArtifact,
    sha256,
} from "./manifestPolicy.ts";
import { currentBunRuntimeIdentity, isBunRuntimeVersion } from "./runtime.ts";

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
    const optionalArtifactPresence = await Promise.all(
        OPTIONAL_RELEASE_STATIC_ARTIFACTS.map(async (relativePath) => {
            try {
                const stat = await fsp.lstat(artifactPath(realReleaseRoot, relativePath));
                if (!stat.isFile() || stat.isSymbolicLink()) {
                    throw new TypeError(
                        `Release artifact must be a regular file: ${relativePath}`
                    );
                }
                return true;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                    return false;
                }
                throw error;
            }
        })
    );
    if (
        optionalArtifactPresence.some(Boolean) &&
        !optionalArtifactPresence.every(Boolean)
    ) {
        throw new TypeError("Managed systemd release artifacts must be complete");
    }
    for (const [index, isPresent] of optionalArtifactPresence.entries()) {
        if (isPresent) {
            paths.push(OPTIONAL_RELEASE_STATIC_ARTIFACTS[index] as string);
        }
    }
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

export function gitOutput(releaseRoot: string, arguments_: string[]): string {
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
        !isBunRuntimeVersion(value.bunVersion)
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
    const bunVersion = options.bunVersion ?? currentBunRuntimeIdentity();
    if (!isBunRuntimeVersion(bunVersion)) {
        throw new TypeError("Release Bun runtime version is invalid");
    }
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
