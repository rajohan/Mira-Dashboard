import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import * as v from "valibot";

import { productionReleaseArtifactReceiptSchema } from "./delivery/packageProductionReleaseArtifact.ts";
import { verifyReleaseArtifactIdentity } from "./delivery/releaseIdentity.ts";

const failureMessage = "Production bootstrap failed";
const projectRoot = path.resolve(import.meta.dir, "..");
const projectHome = "/home/ubuntu/projects/mira-dashboard";
const provisioningRoot = "/var/lib/mira-dashboard-host-provisioning";
const maximumOutputBytes = 1024 * 1024;

interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
}

const githubReleaseSchema = v.strictObject({
    tagName: v.pipe(
        v.string(),
        v.maxLength(128),
        v.regex(/^v\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u)
    ),
});

export interface ProductionBootstrapDependencies {
    readonly run: (command: readonly string[], cwd?: string) => Promise<CommandResult>;
}

export interface ProductionBootstrapOptions {
    readonly createTemporaryRoot?: () => Promise<string>;
    readonly expectedCheckout?: string;
    readonly repositoryRoot?: string;
    readonly userId?: number;
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
        env: process.env,
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
    const [branch, head, upstream, status] = await Promise.all([
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
    ]);
    if (
        branch !== "main" ||
        !/^[a-f\d]{40}$/u.test(head) ||
        head !== upstream ||
        status !== ""
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
export function assertProductionReleaseArchiveListing(
    listing: string,
    releaseId: string
): void {
    const entries = listing.split("\n").filter(Boolean);
    if (
        entries.length === 0 ||
        entries.length > 4096 ||
        entries.some(
            (entry) =>
                !(entry === `${releaseId}/` || entry.startsWith(`${releaseId}/`)) ||
                entry.split("/").includes("..")
        )
    ) {
        throw new Error(failureMessage);
    }
}

/**
 * Downloads the permanent release assets whose Git tag resolves to the checkout commit.
 * @param releaseId Exact clean checkout commit.
 * @param temporaryRoot Private destination directory.
 * @param dependencies Fixed process boundary.
 * @returns The supplied artifact directory after a successful download.
 */
export async function downloadProductionBootstrapRelease(
    releaseId: string,
    temporaryRoot: string,
    dependencies: ProductionBootstrapDependencies
): Promise<string> {
    const releaseText = await requireSuccess(dependencies, [
        "/usr/bin/gh",
        "release",
        "view",
        "--json=tagName",
    ]);
    const unverifiedRelease = v.parse(
        githubReleaseSchema,
        JSON.parse(releaseText) as unknown
    );
    const tagCommit = await requireSuccess(dependencies, [
        "/usr/bin/git",
        "rev-list",
        "-n",
        "1",
        `${unverifiedRelease.tagName}^{commit}`,
    ]);
    const tagName = parseProductionBootstrapRelease(
        unverifiedRelease,
        tagCommit,
        releaseId
    );
    await requireSuccess(dependencies, [
        "/usr/bin/gh",
        "release",
        "download",
        tagName,
        "--pattern=release.tar",
        "--pattern=receipt.json",
        `--dir=${temporaryRoot}`,
    ]);
    return temporaryRoot;
}

/**
 * Verifies and extracts one digest-bound immutable release artifact.
 * @param artifactRoot Directory containing `release.tar` and `receipt.json`.
 * @param releaseId Exact release commit.
 * @param dependencies Fixed process boundary.
 * @param repositoryRoot Checkout root owning the private extraction directory.
 * @returns Verified extracted release root and manifest digest.
 */
export async function admitProductionBootstrapRelease(
    artifactRoot: string,
    releaseId: string,
    dependencies: ProductionBootstrapDependencies,
    repositoryRoot = projectRoot
): Promise<Readonly<{ manifestSha256: string; releaseRoot: string }>> {
    const [receiptBytes, archiveBytes, selectedVersion] = await Promise.all([
        readFile(path.join(artifactRoot, "receipt.json")),
        readFile(path.join(artifactRoot, "release.tar")),
        readFile(path.join(repositoryRoot, ".bun-version"), "utf8"),
    ]);
    const receipt = v.parse(
        productionReleaseArtifactReceiptSchema,
        JSON.parse(receiptBytes.toString("utf8")) as unknown
    );
    if (
        receipt.releaseId !== releaseId ||
        receipt.runtime.version !== selectedVersion.trim() ||
        receipt.archive.bytes !== archiveBytes.byteLength ||
        receipt.archive.sha256 !== sha256(archiveBytes)
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
    await rm(releaseRoot, { force: true, recursive: true });
    await mkdir(releasesRoot, { mode: 0o700, recursive: true });
    await requireSuccess(dependencies, [
        "/usr/bin/tar",
        "-xf",
        path.join(artifactRoot, "release.tar"),
        "-C",
        releasesRoot,
    ]);
    const manifest = await verifyReleaseArtifactIdentity(releaseRoot);
    const manifestBytes = await readFile(path.join(releaseRoot, "release-manifest.json"));
    if (
        manifest.source.commitSha !== releaseId ||
        manifest.runtime.version !== receipt.runtime.version ||
        manifest.runtime.revision !== receipt.runtime.revision ||
        sha256(manifestBytes) !== receipt.releaseManifestSha256
    ) {
        throw new Error(failureMessage);
    }
    return Object.freeze({
        manifestSha256: receipt.releaseManifestSha256,
        releaseRoot,
    });
}

/**
 * Stages and invokes every fixed root-owned production provisioning boundary.
 * @param artifactRoot Directory containing the admitted release archive.
 * @param releaseId Exact release commit.
 * @param manifestSha256 Independently verified release-manifest digest.
 * @param dependencies Fixed process boundary.
 */
export async function stageProductionBootstrapRootAuthority(
    artifactRoot: string,
    releaseId: string,
    manifestSha256: string,
    dependencies: ProductionBootstrapDependencies
): Promise<void> {
    const sudo = "/usr/bin/sudo";
    const stagedRelease = `${provisioningRoot}/releases/${releaseId}`;
    const stagedRuntime = `${provisioningRoot}/runtime/bun`;
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
    await requireSuccess(dependencies, [
        sudo,
        "/usr/bin/tar",
        "-xf",
        path.join(artifactRoot, "release.tar"),
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
    const group = await dependencies.run([
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
    }
    await requireSuccess(dependencies, [
        sudo,
        "/usr/sbin/usermod",
        "--append",
        "--groups",
        "mira-dashboard-log-maintenance",
        "ubuntu",
    ]);
    await requireSuccess(dependencies, [sudo, "/usr/bin/systemctl", "daemon-reload"]);
    await requireSuccess(dependencies, [
        sudo,
        stagedRuntime,
        `${stagedRelease}/scripts/delivery/provisioning/preview-tailscale/operator.ts`,
        "--mode=apply",
    ]);
}

const productionBootstrapDependencies = Object.freeze({ run: defaultRun });

/**
 * Performs the complete first production installation on one clean host.
 * @param dependencies Fixed process boundary used by focused orchestration tests.
 */
export async function bootstrapProduction(
    dependencies: ProductionBootstrapDependencies = productionBootstrapDependencies,
    options: ProductionBootstrapOptions = {}
): Promise<void> {
    const repositoryRoot = options.repositoryRoot ?? projectRoot;
    const releaseId = await resolveProductionBootstrapSourceIdentity(
        dependencies,
        repositoryRoot,
        options.expectedCheckout ?? `${projectHome}/production/checkout`,
        options.userId ?? (typeof process.getuid === "function" ? process.getuid() : 0)
    );
    const selectedVersionFile = await readFile(
        path.join(repositoryRoot, ".bun-version"),
        "utf8"
    );
    const selectedVersion = selectedVersionFile.trim();
    if (Bun.version !== selectedVersion) {
        throw new Error(`Production bootstrap requires Bun ${selectedVersion}`);
    }
    await requireSuccess(
        dependencies,
        [process.execPath, "install", "--frozen-lockfile"],
        repositoryRoot
    );
    const temporaryRoot = options.createTemporaryRoot
        ? await options.createTemporaryRoot()
        : await mkdtemp(path.join(os.tmpdir(), "mira-dashboard-bootstrap-"));
    try {
        const artifactRoot = await downloadProductionBootstrapRelease(
            releaseId,
            temporaryRoot,
            dependencies
        );
        const admitted = await admitProductionBootstrapRelease(
            artifactRoot,
            releaseId,
            dependencies,
            repositoryRoot
        );
        await stageProductionBootstrapRootAuthority(
            artifactRoot,
            releaseId,
            admitted.manifestSha256,
            dependencies
        );
        await requireSuccess(dependencies, [
            process.execPath,
            "run",
            "delivery",
            "prepare-state",
            `--project-root=${projectHome}`,
        ]);
        await requireSuccess(dependencies, [
            process.execPath,
            "run",
            "delivery",
            "activate",
            `--project-root=${projectHome}`,
            `--release-root=${admitted.releaseRoot}`,
            `--runtime-source=${process.execPath}`,
            "--readiness-url=http://127.0.0.1:3100/api/health/ready",
        ]);
    } finally {
        await rm(temporaryRoot, { force: true, recursive: true });
    }
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
