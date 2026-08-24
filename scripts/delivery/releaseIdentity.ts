import { writeFile } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { bunRuntimePolicy } from "../../src/shared/bunRuntimePolicy.ts";
import {
    databaseSchemaTarget,
    migrationManifest,
} from "../../src/shared/databaseMigrationManifest.ts";
import {
    parseReleaseManifest,
    type ReleaseManifest,
    releaseBuildCommands,
    releaseDeliveryProtocols,
    releaseProcessRoles,
    serializeReleaseManifest,
} from "../../src/shared/releaseManifest.ts";
import {
    type BuildSourceIdentity,
    resolveBuildSourceIdentity,
} from "../buildSourceIdentity.ts";
import { readBoundedUtf8RegularFile } from "../files/boundedFile.ts";
import { resolveDirectPackageVersions } from "../packageIdentity.ts";
import { databaseObservabilityProvisioningReleaseArtifactPaths } from "./databaseObservabilityProvisioningPolicy.ts";
import { hostOperationsProvisioningReleaseArtifactPaths } from "./hostOperationsProvisioningPolicy.ts";
import { logMaintenanceProvisioningReleaseArtifactPaths } from "./logMaintenanceProvisioningPolicy.ts";
import { openClawHeartbeatProvisioningReleaseArtifactPaths } from "./openClawHeartbeatProvisioningPolicy.ts";
import { previewTailscaleProvisioningReleaseArtifactPaths } from "./previewTailscaleProvisioningPolicy.ts";
import { productionSystemdUnits } from "./productionSystemdUnitPolicy.ts";
import {
    inventoryReleaseArtifactTree,
    type ReleaseArtifactInventoryRecord,
} from "./releaseArtifactInventory.ts";

const invalidReleaseIdentityMessage = "Release identity is invalid";
const releaseManifestFileName = "release-manifest.json";
const maximumPackageJsonBytes = 1024 * 1024;
const maximumLockfileBytes = 4 * 1024 * 1024;
const maximumManifestBytes = 4 * 1024 * 1024;
const packageGroupSchema = v.record(v.string(), v.string());
const packageJsonSchema = v.object({
    dependencies: packageGroupSchema,
    devDependencies: packageGroupSchema,
    name: v.literal("mira-dashboard"),
    private: v.literal(true),
});
const allowedArtifactRoots = new Set([
    "browser",
    "docs",
    "metadata",
    "migrations",
    "scripts",
    "server",
    "systemd",
]);
const exactMetadataPaths = Object.freeze([
    "metadata/.bun-version",
    "metadata/bun.lock",
    "metadata/package.json",
] as const);
const exactSystemdPaths = Object.freeze(
    productionSystemdUnits.map(({ artifactPath }) => artifactPath)
);
const exactScriptPaths = Object.freeze(
    [
        ...databaseObservabilityProvisioningReleaseArtifactPaths,
        ...hostOperationsProvisioningReleaseArtifactPaths,
        ...logMaintenanceProvisioningReleaseArtifactPaths,
        ...openClawHeartbeatProvisioningReleaseArtifactPaths,
        ...previewTailscaleProvisioningReleaseArtifactPaths,
    ].toSorted()
);

/** Bun identity observed by release creation and activation verification. */
export interface ReleaseRuntimeIdentity {
    readonly revision: string;
    readonly version: string;
}

/** Inputs for one manifest derived from an already staged release tree. */
export interface CreateReleaseIdentityOptions {
    readonly releaseRoot: string;
    readonly repositoryRoot: string;
    readonly runtimeIdentity?: ReleaseRuntimeIdentity;
    readonly sourceDisplay: Readonly<{
        readonly builtAtMs: number;
        readonly commitTitle: string;
    }>;
    readonly sourceIdentity?: BuildSourceIdentity;
}

function invalidReleaseIdentity(): Error {
    return new Error(invalidReleaseIdentityMessage);
}

function compareCanonicalText(left: string, right: string): number {
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
}

function sha256(value: string | Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function currentRuntimeIdentity(): ReleaseRuntimeIdentity {
    return Object.freeze({ revision: Bun.revision, version: Bun.version });
}

function validateRoots(repositoryRoot: string, releaseRoot: string): void {
    const expectedReleaseParent = path.join(repositoryRoot, "dist");
    const releaseRelative = path.relative(expectedReleaseParent, releaseRoot);
    if (
        !path.isAbsolute(repositoryRoot) ||
        !path.isAbsolute(releaseRoot) ||
        repositoryRoot.includes("\0") ||
        releaseRoot.includes("\0") ||
        path.resolve(repositoryRoot) !== repositoryRoot ||
        path.resolve(releaseRoot) !== releaseRoot ||
        releaseRelative.length === 0 ||
        releaseRelative === ".." ||
        releaseRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(releaseRelative)
    ) {
        throw invalidReleaseIdentity();
    }
}

async function readUtf8(
    filePath: string,
    allowedRoot: string,
    maximumBytes: number
): Promise<{ bytes: Buffer; text: string }> {
    return readBoundedUtf8RegularFile(
        filePath,
        allowedRoot,
        maximumBytes,
        invalidReleaseIdentityMessage,
        invalidReleaseIdentityMessage
    );
}

async function readPackageInputs(root: string, metadataPrefix: string) {
    const [packageFile, lockfile] = await Promise.all([
        readUtf8(
            path.join(root, metadataPrefix, "package.json"),
            root,
            maximumPackageJsonBytes
        ),
        readUtf8(path.join(root, metadataPrefix, "bun.lock"), root, maximumLockfileBytes),
    ]);
    let packageValue: unknown;
    try {
        packageValue = JSON.parse(packageFile.text) as unknown;
    } catch {
        throw invalidReleaseIdentity();
    }
    const parsed = v.safeParse(packageJsonSchema, packageValue, { abortEarly: true });
    if (!parsed.success) throw invalidReleaseIdentity();
    const duplicatePackages = Object.keys(parsed.output.dependencies).filter((name) =>
        Object.hasOwn(parsed.output.devDependencies, name)
    );
    if (duplicatePackages.length > 0) throw invalidReleaseIdentity();
    let versions: Readonly<Record<string, string>>;
    try {
        versions = resolveDirectPackageVersions(
            [parsed.output.dependencies, parsed.output.devDependencies],
            lockfile.text
        );
    } catch {
        throw invalidReleaseIdentity();
    }
    const packages = [
        ...Object.keys(parsed.output.dependencies).map((name) => ({
            name,
            scope: "dependency" as const,
            version: versions[name]!,
        })),
        ...Object.keys(parsed.output.devDependencies).map((name) => ({
            name,
            scope: "devDependency" as const,
            version: versions[name]!,
        })),
    ].toSorted((left, right) => compareCanonicalText(left.name, right.name));
    if (packages.length === 0) throw invalidReleaseIdentity();
    return Object.freeze({ lockfile, packageFile, packages: Object.freeze(packages) });
}

function sameArtifactRecords(
    left: readonly ReleaseArtifactInventoryRecord[],
    right: readonly ReleaseArtifactInventoryRecord[]
): boolean {
    return (
        left.length === right.length &&
        left.every(
            (record, index) =>
                record.bytes === right[index]?.bytes &&
                record.path === right[index]?.path &&
                record.sha256 === right[index]?.sha256
        )
    );
}

function documentationRecords(
    artifacts: readonly ReleaseArtifactInventoryRecord[]
): readonly ReleaseArtifactInventoryRecord[] {
    const records = artifacts.filter(({ path: artifactPath }) =>
        artifactPath.startsWith("docs/generated/")
    );
    if (records.length === 0) throw invalidReleaseIdentity();
    return records;
}

function aggregateArtifactIdentity(
    records: readonly ReleaseArtifactInventoryRecord[]
): string {
    return sha256(JSON.stringify(records));
}

function artifactByPath(
    artifacts: readonly ReleaseArtifactInventoryRecord[],
    artifactPath: string
): ReleaseArtifactInventoryRecord {
    const artifact = artifacts.find(({ path: candidate }) => candidate === artifactPath);
    if (!artifact) throw invalidReleaseIdentity();
    return artifact;
}

function assertArtifactShape(
    artifacts: readonly ReleaseArtifactInventoryRecord[],
    migrations: ReleaseManifest["migrations"]
): void {
    for (const artifact of artifacts) {
        const root = artifact.path.split("/", 1)[0];
        if (!root || !allowedArtifactRoots.has(root)) throw invalidReleaseIdentity();
    }
    for (const requiredPath of [
        ...exactMetadataPaths,
        ...exactSystemdPaths,
        "browser/index.html",
        "server/databaseMaintenance.js",
        "server/openClawHeartbeat.js",
        "server/productionDelivery.js",
        "server/resetDashboardPassword.js",
        "server/web.js",
        "server/worker.js",
    ]) {
        artifactByPath(artifacts, requiredPath);
    }
    const metadataPaths = artifacts
        .filter(({ path: artifactPath }) => artifactPath.startsWith("metadata/"))
        .map(({ path: artifactPath }) => artifactPath);
    if (
        metadataPaths.length !== exactMetadataPaths.length ||
        exactMetadataPaths.some((expected, index) => metadataPaths[index] !== expected)
    ) {
        throw invalidReleaseIdentity();
    }
    const systemdPaths = artifacts
        .filter(({ path: artifactPath }) => artifactPath.startsWith("systemd/"))
        .map(({ path: artifactPath }) => artifactPath);
    if (
        systemdPaths.length !== exactSystemdPaths.length ||
        exactSystemdPaths.some((expected, index) => systemdPaths[index] !== expected)
    ) {
        throw invalidReleaseIdentity();
    }
    const scriptPaths = artifacts
        .filter(({ path: artifactPath }) => artifactPath.startsWith("scripts/"))
        .map(({ path: artifactPath }) => artifactPath);
    if (
        scriptPaths.length !== exactScriptPaths.length ||
        exactScriptPaths.some((expected, index) => scriptPaths[index] !== expected)
    ) {
        throw invalidReleaseIdentity();
    }

    const expectedMigrationPaths = migrations
        .flatMap(({ id }) => [
            `migrations/${id}/migration.sql`,
            `migrations/${id}/snapshot.json`,
        ])
        .toSorted(compareCanonicalText);
    const migrationPaths = artifacts
        .filter(({ path: artifactPath }) => artifactPath.startsWith("migrations/"))
        .map(({ path: artifactPath }) => artifactPath);
    if (
        migrationPaths.length !== expectedMigrationPaths.length ||
        expectedMigrationPaths.some(
            (expected, index) => migrationPaths[index] !== expected
        )
    ) {
        throw invalidReleaseIdentity();
    }
    for (const migration of migrations) {
        if (
            artifactByPath(artifacts, `migrations/${migration.id}/migration.sql`)
                .sha256 !== migration.migrationSha256 ||
            artifactByPath(artifacts, `migrations/${migration.id}/snapshot.json`)
                .sha256 !== migration.snapshotSha256
        ) {
            throw invalidReleaseIdentity();
        }
    }
}

async function sourceDocumentationIdentity(repositoryRoot: string): Promise<string> {
    const documentationRoot = path.join(repositoryRoot, "docs/generated");
    const sourceRecords = await inventoryReleaseArtifactTree(documentationRoot);
    return aggregateArtifactIdentity(
        sourceRecords.map((record) => ({
            ...record,
            path: `docs/generated/${record.path}`,
        }))
    );
}

function assertRuntimeIdentity(runtime: ReleaseRuntimeIdentity): void {
    if (
        runtime.version !== bunRuntimePolicy.version ||
        !/^[a-f\d]{40}$/u.test(runtime.revision)
    ) {
        throw invalidReleaseIdentity();
    }
}

/**
 * Derives a complete manifest from the clean checkout and staged release bytes.
 * @param options Canonical repository/staging roots and optional test identities.
 * @returns Parsed immutable release manifest.
 */
export async function createReleaseIdentity(
    options: CreateReleaseIdentityOptions
): Promise<ReleaseManifest> {
    validateRoots(options.repositoryRoot, options.releaseRoot);
    const source =
        options.sourceIdentity ??
        (await resolveBuildSourceIdentity(options.repositoryRoot));
    if (source.state !== "clean") throw invalidReleaseIdentity();
    const runtime = options.runtimeIdentity ?? currentRuntimeIdentity();
    assertRuntimeIdentity(runtime);

    const artifacts = await inventoryReleaseArtifactTree(options.releaseRoot);
    if (
        artifacts.some(
            ({ path: artifactPath }) => artifactPath === releaseManifestFileName
        )
    ) {
        throw invalidReleaseIdentity();
    }
    assertArtifactShape(artifacts, migrationManifest);
    const [sourcePackages, stagedPackages, sourceDocsSha256, sourceBunVersion] =
        await Promise.all([
            readPackageInputs(options.repositoryRoot, ""),
            readPackageInputs(options.releaseRoot, "metadata"),
            sourceDocumentationIdentity(options.repositoryRoot),
            readUtf8(
                path.join(options.repositoryRoot, ".bun-version"),
                options.repositoryRoot,
                128
            ),
        ]);
    if (
        sourceBunVersion.text !== `${bunRuntimePolicy.channel}\n` ||
        sha256(sourceBunVersion.bytes) !==
            artifactByPath(artifacts, "metadata/.bun-version").sha256 ||
        sha256(sourcePackages.lockfile.bytes) !==
            artifactByPath(artifacts, "metadata/bun.lock").sha256 ||
        sha256(sourcePackages.packageFile.bytes) !==
            artifactByPath(artifacts, "metadata/package.json").sha256 ||
        JSON.stringify(sourcePackages.packages) !==
            JSON.stringify(stagedPackages.packages)
    ) {
        throw invalidReleaseIdentity();
    }
    const stagedDocumentationSha256 = aggregateArtifactIdentity(
        documentationRecords(artifacts)
    );
    if (stagedDocumentationSha256 !== sourceDocsSha256) {
        throw invalidReleaseIdentity();
    }

    return parseReleaseManifest({
        artifacts,
        buildCommands: [...releaseBuildCommands],
        deliveryProtocols: [...releaseDeliveryProtocols],
        display: {
            builtAtMs: options.sourceDisplay.builtAtMs,
            commitTitle: options.sourceDisplay.commitTitle,
            schemaTarget: databaseSchemaTarget,
        },
        documentationSha256: stagedDocumentationSha256,
        formatVersion: 1,
        lockfileSha256: artifactByPath(artifacts, "metadata/bun.lock").sha256,
        migrations: migrationManifest.map((migration) => ({ ...migration })),
        packages: stagedPackages.packages,
        processRoles: [...releaseProcessRoles],
        runtime,
        source: { commitSha: source.commitSha, treeState: "clean" },
    });
}

async function reconstructReleaseArtifactIdentity(
    releaseRoot: string
): Promise<ReleaseManifest> {
    const manifestFile = await readUtf8(
        path.join(releaseRoot, releaseManifestFileName),
        releaseRoot,
        maximumManifestBytes
    );
    let manifestValue: unknown;
    try {
        manifestValue = JSON.parse(manifestFile.text) as unknown;
    } catch {
        throw invalidReleaseIdentity();
    }
    let manifest: ReleaseManifest;
    try {
        manifest = parseReleaseManifest(manifestValue);
    } catch {
        throw invalidReleaseIdentity();
    }
    assertRuntimeIdentity(manifest.runtime);

    const completeInventory = await inventoryReleaseArtifactTree(releaseRoot);
    const artifacts = completeInventory.filter(
        ({ path: artifactPath }) => artifactPath !== releaseManifestFileName
    );
    if (
        completeInventory.length !== artifacts.length + 1 ||
        !sameArtifactRecords(manifest.artifacts, artifacts)
    ) {
        throw invalidReleaseIdentity();
    }
    assertArtifactShape(artifacts, manifest.migrations);
    const stagedPackages = await readPackageInputs(releaseRoot, "metadata");
    const stagedBunVersion = await readUtf8(
        path.join(releaseRoot, "metadata/.bun-version"),
        releaseRoot,
        128
    );
    if (
        stagedBunVersion.text !== `${bunRuntimePolicy.channel}\n` ||
        sha256(stagedBunVersion.bytes) !==
            artifactByPath(artifacts, "metadata/.bun-version").sha256 ||
        manifest.lockfileSha256 !==
            artifactByPath(artifacts, "metadata/bun.lock").sha256 ||
        manifest.documentationSha256 !==
            aggregateArtifactIdentity(documentationRecords(artifacts)) ||
        JSON.stringify(manifest.packages) !== JSON.stringify(stagedPackages.packages)
    ) {
        throw invalidReleaseIdentity();
    }
    return manifest;
}

/**
 * Reconstructs every identity represented by one release artifact.
 * This proves the manifest against its bytes but does not prove an executable runtime.
 * Activation must bind the returned runtime identity to its explicit runtime source.
 * @param releaseRoot Canonical immutable-release candidate root.
 * @returns Deeply frozen, internally consistent manifest.
 */
export function verifyReleaseArtifactIdentity(
    releaseRoot: string
): Promise<ReleaseManifest> {
    return reconstructReleaseArtifactIdentity(releaseRoot);
}

/**
 * Reconstructs a release identity and binds it to one already selected Bun runtime.
 * @param releaseRoot Canonical immutable-release candidate root.
 * @param runtimeIdentity Bun runtime selected to serve the candidate.
 * @returns Deeply frozen verified manifest.
 */
export async function verifyReleaseIdentity(
    releaseRoot: string,
    runtimeIdentity: ReleaseRuntimeIdentity
): Promise<ReleaseManifest> {
    assertRuntimeIdentity(runtimeIdentity);
    const manifest = await reconstructReleaseArtifactIdentity(releaseRoot);
    if (
        manifest.runtime.version !== runtimeIdentity.version ||
        manifest.runtime.revision !== runtimeIdentity.revision
    ) {
        throw invalidReleaseIdentity();
    }
    return manifest;
}

/**
 * Writes a new manifest without overwriting an existing candidate, then rereads and verifies it.
 * @param options Canonical repository and staged-release inputs.
 * @returns Verified persisted release identity.
 */
export async function writeReleaseIdentity(
    options: CreateReleaseIdentityOptions
): Promise<ReleaseManifest> {
    const manifest = await createReleaseIdentity(options);
    try {
        await writeFile(
            path.join(options.releaseRoot, releaseManifestFileName),
            serializeReleaseManifest(manifest),
            { encoding: "utf8", flag: "wx", mode: 0o600 }
        );
    } catch {
        throw invalidReleaseIdentity();
    }
    return verifyReleaseIdentity(
        options.releaseRoot,
        options.runtimeIdentity ?? currentRuntimeIdentity()
    );
}
