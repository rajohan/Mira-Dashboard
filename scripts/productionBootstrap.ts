import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as v from "valibot";

import { applicationConfigurationRegistry } from "../src/shared/configuration/applicationConfigurationRegistry.ts";
import {
    maximumProductionReleaseArchiveBytes,
    productionReleaseArtifactReceiptSchema,
    type ProductionReleaseArtifactReceipt,
} from "../src/shared/productionReleaseArtifactReceipt.ts";
import {
    publishedReleaseAuthoritySchema,
    type PublishedReleaseAuthority,
} from "../src/shared/publishedReleaseAuthority.ts";
import { deliverProductionReleaseUnderLease } from "./delivery/activateProductionRelease.ts";
import { withDeploymentLease } from "./delivery/deploymentLease.ts";
import { prepareProductionDeliveryDirectories } from "./delivery/productionDeliveryFilesystem.ts";
import { assertProductionReleaseArchiveListing } from "./delivery/productionReleaseArchive.ts";
import { discardOwnedProductionReleaseCandidate } from "./delivery/productionReleasePublication.ts";
import { prepareProtectedProductionStatePath } from "./delivery/productionStateFilesystem.ts";
import { verifyReleaseArtifactIdentity } from "./delivery/releaseIdentity.ts";
import { createSystemdProductionServiceController } from "./delivery/systemdProductionServices.ts";

const failureMessage = "Production bootstrap failed";
const projectRoot = path.resolve(import.meta.dir, "..");
const projectHome = "/home/ubuntu/projects/mira-dashboard";
const canonicalRepository = "rajohan/Mira-Dashboard";
const canonicalRepositoryUrl = "https://github.com/rajohan/Mira-Dashboard.git";
const provisioningRoot = "/var/lib/mira-dashboard-host-provisioning";
const maximumOutputBytes = 1024 * 1024;
const maximumReceiptBytes = 4 * 1024 * 1024;
const productionProvisioningDeadlineMs = 5 * 60 * 1000;
const dopplerConfigurationNames = applicationConfigurationRegistry
    .filter(
        (entry) =>
            entry.required ||
            entry.environmentName === "MIRA_DASHBOARD_PORT" ||
            entry.environmentName === "MIRA_DASHBOARD_DATABASE_OBSERVABILITY_PASSWORD"
    )
    .map((entry) => entry.environmentName)
    .join(",");
const minimumUnprivilegedGroupId = 100;

interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
}

async function hashBoundedReleaseArchive(target: string): Promise<
    Readonly<{
        bytes: number;
        sha256: string;
    }>
> {
    const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        const status = await handle.stat();
        if (
            !status.isFile() ||
            status.size === 0 ||
            status.size > maximumProductionReleaseArchiveBytes
        ) {
            throw new Error(failureMessage);
        }
        const hash = createHash("sha256");
        const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, status.size));
        let offset = 0;
        while (offset < status.size) {
            const length = Math.min(buffer.byteLength, status.size - offset);
            const { bytesRead } = await handle.read(buffer, 0, length, offset);
            if (bytesRead === 0) throw new Error(failureMessage);
            hash.update(buffer.subarray(0, bytesRead));
            offset += bytesRead;
        }
        return Object.freeze({ bytes: status.size, sha256: hash.digest("hex") });
    } finally {
        await handle.close();
    }
}

const githubReleaseSchema = v.strictObject({
    tagName: v.pipe(
        v.string(),
        v.maxLength(128),
        v.regex(/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u)
    ),
});

const githubReleaseDownloadSchema = v.object({
    assets: v.pipe(
        v.array(
            v.object({
                apiUrl: v.pipe(
                    v.string(),
                    v.regex(
                        /^https:\/\/api\.github\.com\/repos\/rajohan\/Mira-Dashboard\/releases\/assets\/[1-9]\d*$/u
                    )
                ),
                name: v.picklist(["receipt.json", "release.tar"]),
                size: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
            })
        ),
        v.length(2)
    ),
    tagName: githubReleaseSchema.entries.tagName,
});

const tailscaleStatusSchema = v.object({
    BackendState: v.literal("Running"),
    Self: v.object({ Online: v.literal(true) }),
});

export interface ProductionBootstrapDependencies {
    readonly download?: (
        command: readonly string[],
        target: string,
        maximumBytes: number,
        expectedBytes: number,
        cwd?: string
    ) => Promise<void>;
    readonly deliverPublishedRelease?: (
        prepare: () => Promise<PreparedPublishedProductionRelease>
    ) => Promise<void>;
    readonly inspectPrerequisites?: () => Promise<Readonly<{ runtimeSha256: string }>>;
    readonly run: (command: readonly string[], cwd?: string) => Promise<CommandResult>;
}

async function deliverPreparedPublishedRelease(
    prepare: () => Promise<PreparedPublishedProductionRelease>
): Promise<void> {
    const state = await prepareProtectedProductionStatePath(projectHome);
    await withDeploymentLease(state.stateDirectory, async (lease) => {
        const admitted = await prepare();
        const paths = await prepareProductionDeliveryDirectories(state);
        const services = createSystemdProductionServiceController(lease, paths, {
            readinessUrl: "http://127.0.0.1:3100/api/health/ready",
            releaseAuthority: admitted.authority,
        });
        await deliverProductionReleaseUnderLease(
            lease,
            paths,
            {
                projectRoot: projectHome,
                readinessUrl: "http://127.0.0.1:3100/api/health/ready",
                releaseAuthority: admitted.authority,
                releaseRoot: admitted.releaseRoot,
                runtimeSource: path.join(admitted.releaseRoot, "runtime/bun"),
            },
            await verifyReleaseArtifactIdentity(admitted.releaseRoot),
            services
        );
    });
}

export interface ProductionBootstrapOptions {
    readonly createTemporaryRoot?: () => Promise<string>;
    readonly expectedCheckout?: string;
    readonly repositoryRoot?: string;
    readonly userId?: number;
}

export interface PreparedPublishedProductionRelease {
    readonly authority: PublishedReleaseAuthority;
    readonly releaseId: string;
    readonly releaseRoot: string;
}

interface DownloadedProductionBootstrapRelease {
    readonly artifactRoot: string;
    readonly tagName: string;
}

interface ProductionBootstrapPathStatus {
    readonly gid: number;
    readonly mode: number;
    readonly nlink: number;
    readonly uid: number;
    isDirectory(): boolean;
    isFile(): boolean;
}

function parseMaintenanceGroup(
    stdout: string,
    expectedMembers: string
): Readonly<{ groupId: number; line: string }> | undefined {
    const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
    const match = /^mira-dashboard-log-maintenance:[^:\n]*:(\d{1,10}):([^\n]*)$/u.exec(
        line
    );
    if (!match || match[2] !== expectedMembers) return undefined;
    const groupId = Number(match[1]);
    return Number.isSafeInteger(groupId) && groupId >= minimumUnprivilegedGroupId
        ? Object.freeze({ groupId, line })
        : undefined;
}

async function maintenanceGroupIsUnique(
    dependencies: ProductionBootstrapDependencies,
    group: Readonly<{ groupId: number; line: string }>
): Promise<boolean> {
    const inventory = await dependencies.run(["/usr/bin/getent", "group"]);
    if (inventory.exitCode !== 0) return false;
    const aliases = inventory.stdout
        .split("\n")
        .filter(Boolean)
        .filter((line) => {
            const fields = line.split(":");
            return fields.length === 4 && Number(fields[2]) === group.groupId;
        });
    return aliases.length === 1 && aliases[0] === group.line;
}

export interface ProductionBootstrapPrerequisiteFilesystem {
    readonly canonical: (target: string) => Promise<string>;
    readonly read: (target: string) => Promise<Uint8Array>;
    readonly status: (target: string) => Promise<ProductionBootstrapPathStatus>;
}

async function readBounded(stream: ReadableStream<Uint8Array>): Promise<string> {
    const response = new Response(stream);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maximumOutputBytes) throw new Error(failureMessage);
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function defaultRun(
    command: readonly string[],
    cwd = projectRoot
): Promise<CommandResult> {
    const child = Bun.spawn([...command], {
        cwd,
        env: productionCommandEnvironment(),
        stderr: "inherit",
        stdin: "inherit",
        stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
        child.exited,
        readBounded(child.stdout),
    ]);
    return Object.freeze({ exitCode, stdout });
}

function productionCommandEnvironment(): NodeJS.ProcessEnv {
    const token = process.env.MIRA_GITHUB_TOKEN;
    if (token === undefined) return process.env;
    return {
        ...process.env,
        GH_TOKEN: token,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
            `x-access-token:${token}`
        ).toString("base64")}`,
    };
}

async function defaultDownload(
    command: readonly string[],
    target: string,
    maximumBytes: number,
    expectedBytes: number,
    cwd = projectRoot
): Promise<void> {
    if (expectedBytes < 1 || expectedBytes > maximumBytes) {
        throw new Error(failureMessage);
    }
    const handle = await open(
        target,
        constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_WRONLY,
        0o600
    );
    const child = Bun.spawn([...command], {
        cwd,
        env: productionCommandEnvironment(),
        signal: AbortSignal.timeout(productionProvisioningDeadlineMs),
        stderr: "ignore",
        stdin: "ignore",
        stdout: "pipe",
    });
    const reader = child.stdout.getReader();
    let bytes = 0;
    let admitted = false;
    try {
        while (true) {
            const next = await reader.read();
            if (next.done) break;
            if (next.value.byteLength > maximumBytes - bytes) {
                child.kill();
                throw new Error(failureMessage);
            }
            let offset = 0;
            while (offset < next.value.byteLength) {
                const written = await handle.write(
                    next.value,
                    offset,
                    next.value.byteLength - offset,
                    bytes + offset
                );
                if (written.bytesWritten < 1) throw new Error(failureMessage);
                offset += written.bytesWritten;
            }
            bytes += next.value.byteLength;
        }
        if ((await child.exited) !== 0 || bytes !== expectedBytes) {
            throw new Error(failureMessage);
        }
        await handle.sync();
        admitted = true;
    } catch {
        child.kill();
        await child.exited.catch(() => null);
        throw new Error(failureMessage);
    } finally {
        reader.releaseLock();
        await handle.close();
        if (!admitted) await rm(target, { force: true });
    }
}

async function requireSuccess(
    dependencies: ProductionBootstrapDependencies,
    command: readonly string[],
    cwd = projectRoot
): Promise<string> {
    const result = await dependencies.run(command, cwd);
    if (result.exitCode !== 0) throw new Error(failureMessage);
    return result.stdout.trim();
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

/**
 * Verifies the non-root canonical checkout and returns exact clean `main` identity.
 * @param dependencies Fixed process boundary.
 * @param repositoryRoot Checkout root to inspect.
 * @param expectedCheckout Canonical path required for that checkout.
 * @param userId Effective non-root user identity.
 * @returns Full clean commit SHA shared with `origin/main`.
 */
export async function resolveProductionBootstrapSourceIdentity(
    dependencies: ProductionBootstrapDependencies,
    repositoryRoot = projectRoot,
    expectedCheckout = `${projectHome}/production/checkout`,
    userId = typeof process.getuid === "function" ? process.getuid() : 0
): Promise<string> {
    if (userId === 0) {
        throw new Error("Run production bootstrap as the managed non-root user");
    }
    if ((await realpath(repositoryRoot)) !== expectedCheckout) {
        throw new Error(`Production bootstrap checkout must be ${expectedCheckout}`);
    }
    const [branch, head, upstream, status, origin] = await Promise.all([
        requireSuccess(
            dependencies,
            ["/usr/bin/git", "branch", "--show-current"],
            repositoryRoot
        ),
        requireSuccess(
            dependencies,
            ["/usr/bin/git", "rev-parse", "HEAD"],
            repositoryRoot
        ),
        requireSuccess(
            dependencies,
            ["/usr/bin/git", "rev-parse", "origin/main"],
            repositoryRoot
        ),
        requireSuccess(
            dependencies,
            ["/usr/bin/git", "status", "--porcelain=v1"],
            repositoryRoot
        ),
        requireSuccess(
            dependencies,
            ["/usr/bin/git", "remote", "get-url", "origin"],
            repositoryRoot
        ),
    ]);
    if (
        branch !== "main" ||
        !/^[a-f\d]{40}$/u.test(head) ||
        head !== upstream ||
        status !== "" ||
        origin !== canonicalRepositoryUrl
    ) {
        throw new Error("Production bootstrap requires clean main at exact origin/main");
    }
    return head;
}

/**
 * Admits the GitHub release identity used by a clean-host bootstrap.
 * @param value Untrusted `gh release view` JSON.
 * @param tagCommit Commit resolved from the release's Git tag.
 * @param releaseId Exact clean checkout commit.
 * @returns Validated semantic tag for the exact commit.
 */
export function parseProductionBootstrapRelease(
    value: unknown,
    tagCommit: string,
    releaseId: string
): string {
    const release = v.parse(githubReleaseSchema, value);
    if (tagCommit !== releaseId || !/^[a-f\d]{40}$/u.test(tagCommit)) {
        throw new Error(failureMessage);
    }
    return release.tagName;
}

/**
 * Rejects archive paths outside the single commit-addressed release directory.
 * @param listing Newline-delimited `tar -tf` output.
 * @param releaseId Exact clean checkout commit.
 */
/**
 * Downloads the permanent release assets whose Git tag resolves to the checkout commit.
 * @param releaseId Exact clean checkout commit.
 * @param temporaryRoot Private destination directory.
 * @param dependencies Fixed process boundary.
 * @param repositoryRoot Checkout used to resolve the release tag.
 * @param expectedTagName Optional payload-bound release tag for normal Delivery.
 * @returns The supplied artifact directory after a successful download.
 */
export async function downloadProductionBootstrapRelease(
    releaseId: string,
    temporaryRoot: string,
    dependencies: ProductionBootstrapDependencies,
    repositoryRoot = projectRoot,
    expectedTagName?: string
): Promise<DownloadedProductionBootstrapRelease> {
    const releaseText = await requireSuccess(dependencies, [
        "/usr/bin/gh",
        "release",
        "view",
        ...(expectedTagName === undefined ? [] : [expectedTagName]),
        `--repo=${canonicalRepository}`,
        "--json=assets,tagName",
    ]);
    const unverifiedRelease = v.parse(
        githubReleaseDownloadSchema,
        JSON.parse(releaseText) as unknown
    );
    await requireSuccess(
        dependencies,
        [
            "/usr/bin/git",
            "fetch",
            "--force",
            "--no-tags",
            "origin",
            `refs/tags/${unverifiedRelease.tagName}:refs/tags/${unverifiedRelease.tagName}`,
        ],
        repositoryRoot
    );
    const tagCommit = await requireSuccess(
        dependencies,
        ["/usr/bin/git", "rev-list", "-n", "1", `${unverifiedRelease.tagName}^{commit}`],
        repositoryRoot
    );
    const tagName = parseProductionBootstrapRelease(
        { tagName: unverifiedRelease.tagName },
        tagCommit,
        releaseId
    );
    const download = dependencies.download ?? defaultDownload;
    for (const [name, maximumBytes] of [
        ["receipt.json", maximumReceiptBytes],
        ["release.tar", maximumProductionReleaseArchiveBytes],
    ] as const) {
        const asset = unverifiedRelease.assets.find(
            (candidate) => candidate.name === name
        );
        if (asset === undefined || asset.size > maximumBytes) {
            throw new Error(failureMessage);
        }
        await download(
            [
                "/usr/bin/gh",
                "api",
                "--header=Accept: application/octet-stream",
                asset.apiUrl,
            ],
            path.join(temporaryRoot, name),
            maximumBytes,
            asset.size,
            repositoryRoot
        );
    }
    return Object.freeze({ artifactRoot: temporaryRoot, tagName });
}

/** Test-only seams for bounded release downloads and credential projection. */
export const productionBootstrapTestSupport = Object.freeze({
    download: defaultDownload,
    environment: productionCommandEnvironment,
});

/**
 * Verifies and extracts one digest-bound immutable release artifact.
 * @param artifactRoot Directory containing `release.tar` and `receipt.json`.
 * @param releaseId Exact release commit.
 * @param dependencies Fixed process boundary.
 * @param repositoryRoot Checkout root owning the private extraction directory.
 * @param expectedAuthority Optional exact public GitHub release authority.
 * @returns Verified extracted release root and manifest digest.
 */
export async function admitProductionBootstrapRelease(
    artifactRoot: string,
    releaseId: string,
    dependencies: ProductionBootstrapDependencies,
    repositoryRoot = projectRoot,
    expectedAuthority?: PublishedReleaseAuthority
): Promise<
    Readonly<{
        archiveBytes: number;
        archiveSha256: string;
        manifestSha256: string;
        receiptBytes: number;
        receiptSha256: string;
        releaseRoot: string;
        runtime: ProductionReleaseArtifactReceipt["runtime"];
    }>
> {
    const [receiptBytes, archive, selectedVersion] = await Promise.all([
        readFile(path.join(artifactRoot, "receipt.json")),
        hashBoundedReleaseArchive(path.join(artifactRoot, "release.tar")),
        readFile(path.join(repositoryRoot, ".bun-version"), "utf8"),
    ]);
    const receipt = v.parse(
        productionReleaseArtifactReceiptSchema,
        JSON.parse(receiptBytes.toString("utf8")) as unknown
    );
    const receiptSha256 = sha256(receiptBytes);
    const archiveSha256 = archive.sha256;
    const expectedReceiptAsset = expectedAuthority?.assets.find(
        ({ name }) => name === "receipt.json"
    );
    const expectedArchiveAsset = expectedAuthority?.assets.find(
        ({ name }) => name === "release.tar"
    );
    if (
        receipt.releaseId !== releaseId ||
        receipt.runtime.version !== selectedVersion.trim() ||
        receipt.archive.bytes !== archive.bytes ||
        receipt.archive.sha256 !== archiveSha256 ||
        (expectedAuthority !== undefined &&
            (expectedAuthority.releaseId !== releaseId ||
                expectedAuthority.releaseManifestSha256 !==
                    receipt.releaseManifestSha256 ||
                expectedAuthority.runtime.revision !== receipt.runtime.revision ||
                expectedAuthority.runtime.version !== receipt.runtime.version ||
                expectedReceiptAsset?.size !== receiptBytes.byteLength ||
                expectedReceiptAsset.digest !== `sha256:${receiptSha256}` ||
                expectedArchiveAsset?.size !== archive.bytes ||
                expectedArchiveAsset.digest !== `sha256:${archiveSha256}`))
    ) {
        throw new Error(failureMessage);
    }
    const listing = await requireSuccess(dependencies, [
        "/usr/bin/tar",
        "-tf",
        path.join(artifactRoot, "release.tar"),
    ]);
    assertProductionReleaseArchiveListing(listing, releaseId);
    const releasesRoot = path.join(repositoryRoot, "dist/releases");
    const releaseRoot = path.join(releasesRoot, releaseId);
    await mkdir(releasesRoot, { mode: 0o700, recursive: true });
    await discardOwnedProductionReleaseCandidate(releasesRoot, releaseRoot, releaseId);
    try {
        await requireSuccess(dependencies, [
            "/usr/bin/tar",
            "-xf",
            path.join(artifactRoot, "release.tar"),
            "--no-same-owner",
            "-C",
            releasesRoot,
        ]);
        const manifest = await verifyReleaseArtifactIdentity(releaseRoot);
        const manifestBytes = await readFile(
            path.join(releaseRoot, "release-manifest.json")
        );
        if (
            manifest.source.commitSha !== releaseId ||
            manifest.runtime.version !== receipt.runtime.version ||
            manifest.runtime.revision !== receipt.runtime.revision ||
            sha256(manifestBytes) !== receipt.releaseManifestSha256
        ) {
            throw new Error(failureMessage);
        }
        return Object.freeze({
            archiveBytes: archive.bytes,
            archiveSha256: receipt.archive.sha256,
            manifestSha256: receipt.releaseManifestSha256,
            receiptBytes: receiptBytes.byteLength,
            receiptSha256,
            releaseRoot,
            runtime: receipt.runtime,
        });
    } catch {
        await discardOwnedProductionReleaseCandidate(
            releasesRoot,
            releaseRoot,
            releaseId
        );
        throw new Error(failureMessage);
    }
}

/**
 * Stages and invokes every fixed root-owned production provisioning boundary.
 * @param artifactRoot Directory containing the admitted release archive.
 * @param releaseId Exact release commit.
 * @param manifestSha256 Independently verified release-manifest digest.
 * @param archiveSha256 Digest verified before and after the root-owned archive handoff.
 * @param runtimeSha256 Digest of the root-owned runtime source and staged interpreter.
 * @param userId Canonical non-root production service identity.
 * @param dependencies Fixed process boundary.
 */
export async function stageProductionBootstrapRootAuthority(
    artifactRoot: string,
    releaseId: string,
    manifestSha256: string,
    archiveSha256: string,
    runtimeSha256: string,
    userId: number,
    dependencies: ProductionBootstrapDependencies
): Promise<void> {
    const sudo = "/usr/bin/sudo";
    const stagedRelease = `${provisioningRoot}/releases/${releaseId}`;
    const stagedRuntime = `${provisioningRoot}/runtime/bun`;
    const stagedArchive = `${provisioningRoot}/release.tar`;
    for (const directory of [
        provisioningRoot,
        `${provisioningRoot}/releases`,
        `${provisioningRoot}/runtime`,
    ]) {
        await requireSuccess(dependencies, [
            sudo,
            "/usr/bin/install",
            "-d",
            "-o",
            "root",
            "-g",
            "root",
            "-m",
            "0500",
            directory,
        ]);
    }
    await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/install",
        "-o",
        "root",
        "-g",
        "root",
        "-m",
        "0555",
        process.execPath,
        stagedRuntime,
    ]);
    const installedRuntimeSha256 = await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/sha256sum",
        stagedRuntime,
    ]);
    if (installedRuntimeSha256.split(/\s+/u)[0] !== runtimeSha256) {
        throw new Error(failureMessage);
    }
    await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/install",
        "-o",
        "root",
        "-g",
        "root",
        "-m",
        "0400",
        path.join(artifactRoot, "release.tar"),
        stagedArchive,
    ]);
    const installedArchiveSha256 = await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/sha256sum",
        stagedArchive,
    ]);
    if (installedArchiveSha256.split(/\s+/u)[0] !== archiveSha256) {
        throw new Error(failureMessage);
    }
    await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/tar",
        "-xf",
        stagedArchive,
        "--no-same-owner",
        "-C",
        `${provisioningRoot}/releases`,
    ]);
    await requireSuccess(dependencies, [
        sudo,
        stagedRuntime,
        `${stagedRelease}/scripts/delivery/provisioning/host-operations/installHostOperationsProvisioning.ts`,
        `--release-root=${stagedRelease}`,
        `--release-id=${releaseId}`,
        `--release-manifest-sha256=${manifestSha256}`,
    ]);
    await requireSuccess(dependencies, [
        sudo,
        stagedRuntime,
        `${stagedRelease}/scripts/delivery/provisioning/log-maintenance/installLogMaintenanceProvisioning.ts`,
        `--release-root=${stagedRelease}`,
        `--release-id=${releaseId}`,
    ]);
    let group = await dependencies.run([
        "/usr/bin/getent",
        "group",
        "mira-dashboard-log-maintenance",
    ]);
    if (group.exitCode !== 0) {
        await requireSuccess(dependencies, [
            sudo,
            "/usr/sbin/groupadd",
            "--system",
            "mira-dashboard-log-maintenance",
        ]);
        group = await dependencies.run([
            "/usr/bin/getent",
            "group",
            "mira-dashboard-log-maintenance",
        ]);
    }
    let admittedGroup =
        group.exitCode === 0 ? parseMaintenanceGroup(group.stdout, "") : undefined;
    if (
        !admittedGroup ||
        !(await maintenanceGroupIsUnique(dependencies, admittedGroup))
    ) {
        throw new Error(failureMessage);
    }
    await requireSuccess(dependencies, [
        sudo,
        "/usr/sbin/usermod",
        "--append",
        "--groups",
        "mira-dashboard-log-maintenance",
        "ubuntu",
    ]);
    group = await dependencies.run([
        "/usr/bin/getent",
        "group",
        "mira-dashboard-log-maintenance",
    ]);
    admittedGroup =
        group.exitCode === 0 ? parseMaintenanceGroup(group.stdout, "ubuntu") : undefined;
    if (
        !admittedGroup ||
        !(await maintenanceGroupIsUnique(dependencies, admittedGroup))
    ) {
        throw new Error(failureMessage);
    }
    await requireSuccess(dependencies, [
        sudo,
        stagedRuntime,
        `${stagedRelease}/scripts/delivery/provisioning/log-maintenance/migrateManagedApplicationLogs.ts`,
        `--user-id=${userId}`,
    ]);
    await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/systemd-tmpfiles",
        "--create",
        "/usr/lib/tmpfiles.d/mira-dashboard-managed-container-logs.conf",
    ]);
    await requireSuccess(dependencies, [sudo, "/usr/bin/systemctl", "daemon-reload"]);
    await requireSuccess(dependencies, [
        sudo,
        stagedRuntime,
        `${stagedRelease}/scripts/delivery/provisioning/preview-tailscale/operator.ts`,
        "--mode=apply",
    ]);
}

export const productionBootstrapDependencies = Object.freeze({ run: defaultRun });
const productionBootstrapPrerequisiteFilesystem = Object.freeze({
    canonical: realpath,
    read: (target: string) => readFile(target),
    status: lstat,
} satisfies ProductionBootstrapPrerequisiteFilesystem);

export async function verifyProductionBootstrapPrerequisites(
    dependencies: ProductionBootstrapDependencies,
    repositoryRoot: string,
    userId: number,
    filesystem: ProductionBootstrapPrerequisiteFilesystem = productionBootstrapPrerequisiteFilesystem,
    userGroupId = typeof process.getgid === "function" ? process.getgid() : 0
): Promise<Readonly<{ runtimeSha256: string }>> {
    await requireSuccess(
        dependencies,
        ["/usr/bin/getent", "group", "docker"],
        repositoryRoot
    );
    await requireSuccess(
        dependencies,
        ["/usr/bin/docker", "version", "--format={{.Server.Version}}"],
        repositoryRoot
    );
    await requireSuccess(
        dependencies,
        ["/usr/local/bin/doppler", "--version"],
        repositoryRoot
    );
    const tailscaleStatus = await requireSuccess(
        dependencies,
        ["/usr/bin/tailscale", "status", "--json"],
        repositoryRoot
    );
    v.parse(tailscaleStatusSchema, JSON.parse(tailscaleStatus) as unknown);
    const dopplerRoot = "/home/ubuntu/.doppler";
    const dopplerConfig = `${dopplerRoot}/.doppler.yaml`;
    const openClawWorkspace = "/home/ubuntu/.openclaw/workspace";
    const [
        runtimePath,
        openClawPath,
        openClawWorkspacePath,
        dopplerPath,
        dopplerConfigPath,
    ] = await Promise.all([
        filesystem.canonical(process.execPath),
        filesystem.canonical("/home/ubuntu/.openclaw"),
        filesystem.canonical(openClawWorkspace),
        filesystem.canonical(dopplerRoot),
        filesystem.canonical(dopplerConfig),
    ]);
    const runtimeAncestorPaths: string[] = [];
    let runtimeAncestor = path.dirname(runtimePath);
    while (true) {
        runtimeAncestorPaths.push(runtimeAncestor);
        if (runtimeAncestor === path.parse(runtimeAncestor).root) break;
        runtimeAncestor = path.dirname(runtimeAncestor);
    }
    const [
        runtimeStatus,
        openClawStatus,
        openClawWorkspaceStatus,
        dopplerStatus,
        dopplerConfigStatus,
    ] = await Promise.all([
        filesystem.status(runtimePath),
        filesystem.status(openClawPath),
        filesystem.status(openClawWorkspacePath),
        filesystem.status(dopplerPath),
        filesystem.status(dopplerConfigPath),
    ]);
    const runtimeAncestorStatuses = await Promise.all(
        runtimeAncestorPaths.map((ancestor) => filesystem.status(ancestor))
    );
    if (
        !runtimeStatus.isFile() ||
        runtimeStatus.uid !== 0 ||
        runtimeStatus.gid !== 0 ||
        (runtimeStatus.mode & 0o022) !== 0 ||
        (runtimeStatus.mode & 0o111) === 0 ||
        runtimeAncestorStatuses.some(
            (status) =>
                !status.isDirectory() ||
                status.uid !== 0 ||
                status.gid !== 0 ||
                (status.mode & 0o022) !== 0
        ) ||
        openClawPath !== "/home/ubuntu/.openclaw" ||
        !openClawStatus.isDirectory() ||
        openClawStatus.uid !== userId ||
        openClawStatus.gid !== userGroupId ||
        (openClawStatus.mode & 0o7777) !== 0o700 ||
        openClawWorkspacePath !== openClawWorkspace ||
        !openClawWorkspaceStatus.isDirectory() ||
        openClawWorkspaceStatus.uid !== userId ||
        openClawWorkspaceStatus.gid !== userGroupId ||
        (openClawWorkspaceStatus.mode & 0o022) !== 0 ||
        dopplerPath !== dopplerRoot ||
        !dopplerStatus.isDirectory() ||
        dopplerStatus.uid !== userId ||
        dopplerStatus.gid !== userGroupId ||
        (dopplerStatus.mode & 0o7777) !== 0o700 ||
        dopplerConfigPath !== dopplerConfig ||
        !dopplerConfigStatus.isFile() ||
        dopplerConfigStatus.uid !== userId ||
        dopplerConfigStatus.gid !== userGroupId ||
        (dopplerConfigStatus.mode & 0o7777) !== 0o600 ||
        dopplerConfigStatus.nlink !== 1
    ) {
        throw new Error(failureMessage);
    }
    const runtimeBytes = await filesystem.read(runtimePath);
    await requireSuccess(
        dependencies,
        [
            "/usr/bin/env",
            "-i",
            "HOME=/home/ubuntu",
            "PATH=/usr/local/bin:/usr/bin:/bin",
            "NODE_ENV=production",
            `MIRA_DASHBOARD_PROJECT_ROOT=${projectHome}`,
            "MIRA_DASHBOARD_OPENCLAW_ROOT=/home/ubuntu/.openclaw",
            "MIRA_DASHBOARD_WORKSPACE_ROOT=/home/ubuntu/.openclaw/workspace",
            "/usr/local/bin/doppler",
            "run",
            "--config=prd",
            "--project=rajohan",
            "--config-dir=/home/ubuntu/.doppler",
            "--no-read-env",
            `--only-secrets=${dopplerConfigurationNames}`,
            "--no-exit-on-missing-only-secrets",
            "--preserve-env=NODE_ENV,MIRA_DASHBOARD_PROJECT_ROOT,MIRA_DASHBOARD_OPENCLAW_ROOT,MIRA_DASHBOARD_WORKSPACE_ROOT",
            "--",
            process.execPath,
            path.join(repositoryRoot, "src/app/productionBootstrapConfigurationCheck.ts"),
        ],
        repositoryRoot
    );
    return Object.freeze({ runtimeSha256: sha256(runtimeBytes) });
}

/**
 * Downloads, admits, and root-provisions one exact published production release.
 * @param releaseId Exact clean main commit published by Release Please.
 * @param repositoryRoot Canonical production checkout.
 * @param dependencies Fixed process boundary.
 * @param userId Effective managed-user identity.
 * @param createTemporaryRoot Optional private temporary-root factory.
 * @param expectedAuthority Optional authority supplied by Delivery.
 * @param options Root-staging policy for bootstrap versus normal deploy.
 * @returns Exact admitted release root.
 */
export async function preparePublishedProductionRelease(
    releaseId: string,
    repositoryRoot: string,
    dependencies: ProductionBootstrapDependencies = productionBootstrapDependencies,
    userId = typeof process.getuid === "function" ? process.getuid() : 0,
    createTemporaryRoot: () => Promise<string> = () =>
        mkdtemp(path.join(os.tmpdir(), "mira-dashboard-release-")),
    expectedAuthority?: PublishedReleaseAuthority,
    options: Readonly<{ readonly stageRootAuthority?: boolean }> = {}
): Promise<PreparedPublishedProductionRelease> {
    let prerequisites: Readonly<{ runtimeSha256: string }> | undefined;
    if (options.stageRootAuthority !== false) {
        prerequisites = dependencies.inspectPrerequisites
            ? await dependencies.inspectPrerequisites()
            : await verifyProductionBootstrapPrerequisites(
                  dependencies,
                  repositoryRoot,
                  userId
              );
    }
    const temporaryRoot = await createTemporaryRoot();
    try {
        const downloaded = await downloadProductionBootstrapRelease(
            releaseId,
            temporaryRoot,
            dependencies,
            repositoryRoot,
            expectedAuthority?.tagName
        );
        const admitted = await admitProductionBootstrapRelease(
            downloaded.artifactRoot,
            releaseId,
            dependencies,
            repositoryRoot,
            expectedAuthority
        );
        const authority = v.parse(publishedReleaseAuthoritySchema, {
            assets: [
                {
                    digest: `sha256:${admitted.receiptSha256}`,
                    name: "receipt.json",
                    size: admitted.receiptBytes,
                },
                {
                    digest: `sha256:${admitted.archiveSha256}`,
                    name: "release.tar",
                    size: admitted.archiveBytes,
                },
            ],
            releaseId,
            releaseManifestSha256: admitted.manifestSha256,
            runtime: admitted.runtime,
            tagName: downloaded.tagName,
        });
        await requireSuccess(
            dependencies,
            [
                path.join(admitted.releaseRoot, "runtime/bun"),
                path.join(admitted.releaseRoot, "server/prepareProductionState.js"),
                `--project-root=${projectHome}`,
            ],
            admitted.releaseRoot
        );
        if (options.stageRootAuthority !== false) {
            if (!prerequisites) throw new Error(failureMessage);
            await stageProductionBootstrapRootAuthority(
                downloaded.artifactRoot,
                releaseId,
                admitted.manifestSha256,
                admitted.archiveSha256,
                prerequisites.runtimeSha256,
                userId,
                dependencies
            );
        }
        return Object.freeze({ authority, releaseId, releaseRoot: admitted.releaseRoot });
    } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
    }
}

/**
 * Performs the complete first production installation on one clean host.
 * @param dependencies Fixed process boundary used by focused orchestration tests.
 */
export async function bootstrapProduction(
    dependencies: ProductionBootstrapDependencies = productionBootstrapDependencies,
    options: ProductionBootstrapOptions = {}
): Promise<void> {
    const repositoryRoot = options.repositoryRoot ?? projectRoot;
    const userId =
        options.userId ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const releaseId = await resolveProductionBootstrapSourceIdentity(
        dependencies,
        repositoryRoot,
        options.expectedCheckout ?? `${projectHome}/production/checkout`,
        userId
    );
    const selectedVersionFile = await readFile(
        path.join(repositoryRoot, ".bun-version"),
        "utf8"
    );
    const selectedVersion = selectedVersionFile.trim();
    if (Bun.version !== selectedVersion) {
        throw new Error(`Production bootstrap requires Bun ${selectedVersion}`);
    }
    const admitted = await preparePublishedProductionRelease(
        releaseId,
        repositoryRoot,
        dependencies,
        userId,
        options.createTemporaryRoot
    );
    await requireSuccess(dependencies, [
        process.execPath,
        "run",
        "delivery",
        "activate",
        `--project-root=${projectHome}`,
        `--release-root=${admitted.releaseRoot}`,
        `--runtime-source=${process.execPath}`,
        "--readiness-url=http://127.0.0.1:3100/api/health/ready",
        "--activation-mode=greenfield",
    ]);
}

/**
 * Deploys the exact published Release Please release from a clean production checkout.
 * @param dependencies Fixed process boundary used by focused orchestration tests.
 * @param options Canonical checkout and identity overrides.
 */
export async function deployProduction(
    dependencies: ProductionBootstrapDependencies = productionBootstrapDependencies,
    options: ProductionBootstrapOptions = {}
): Promise<void> {
    const repositoryRoot = options.repositoryRoot ?? projectRoot;
    const userId =
        options.userId ?? (typeof process.getuid === "function" ? process.getuid() : 0);
    const releaseId = await resolveProductionBootstrapSourceIdentity(
        dependencies,
        repositoryRoot,
        options.expectedCheckout ?? `${projectHome}/production/checkout`,
        userId
    );
    await requireSuccess(dependencies, [
        "/usr/bin/systemctl",
        "cat",
        "mira-dashboard-production-provisioning@.service",
    ]);
    await (dependencies.deliverPublishedRelease ?? deliverPreparedPublishedRelease)(() =>
        preparePublishedProductionRelease(
            releaseId,
            repositoryRoot,
            dependencies,
            userId,
            options.createTemporaryRoot,
            undefined,
            { stageRootAuthority: false }
        )
    );
}

if (import.meta.main) {
    try {
        await bootstrapProduction();
        process.stdout.write("Production bootstrap complete.\n");
    } catch (error) {
        process.stderr.write(
            `${error instanceof Error ? error.message : failureMessage}\n`
        );
        process.exitCode = 1;
    }
}
