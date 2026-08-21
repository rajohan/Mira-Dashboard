import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

import {
    installLogMaintenanceProvisioningFiles,
    type LogMaintenanceProvisioningFilesystemTestHooks,
    type VerifiedLogMaintenanceProvisioningFile,
} from "./logMaintenanceProvisioningFilesystem.ts";
import {
    logMaintenanceProvisioningArtifacts,
    logMaintenanceProvisioningReleaseArtifactPaths,
} from "./policy.ts";

const installationFailureMessage = "Log maintenance provisioning installation failed";
const installationUsage =
    "Usage: bun installLogMaintenanceProvisioning.ts --release-root=/absolute/release/<40-hex> --release-id=<40-hex>";
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const immutableDirectoryMode = 0o500n;
const immutableFileMode = 0o400n;
const maximumManifestBytes = 4 * 1024 * 1024;
const maximumProvisioningArtifactBytes = 64 * 1024;
const maximumArtifactCount = 4096;
const commitShaPattern = /^[a-f\d]{40}$/u;
const artifactShaPattern = /^[a-f\d]{64}$/u;
const artifactSegmentPattern = /^[A-Za-z0-9.@_+-]+$/u;
const provisioningPrefix = "scripts/delivery/provisioning/log-maintenance/";

interface ReleaseArtifactRecord {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
}

interface ReleaseDirectory {
    readonly device: bigint;
    readonly groupId: bigint;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly path: string;
    readonly userId: bigint;
}

interface LoadedProvisioningRelease {
    readonly files: readonly VerifiedLogMaintenanceProvisioningFile[];
    readonly identity: string;
}

/** Deterministic non-production boundaries used only by focused installer tests. */
export interface InstallLogMaintenanceProvisioningTestHooks {
    readonly destinationRoot?: string;
    readonly filesystem?: LogMaintenanceProvisioningFilesystemTestHooks;
    readonly requireRoot?: () => void;
}

/** Exact root installer CLI inputs. */
export interface InstallLogMaintenanceProvisioningArguments {
    readonly releaseId: string;
    readonly releaseRoot: string;
}

/** Redacted root installer result; no host paths or artifact details are exposed. */
export interface InstallLogMaintenanceProvisioningResult {
    readonly releaseId: string;
    readonly status: "INSTALLED";
}

function installationFailure(): Error {
    return new Error(installationFailureMessage);
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function closeHandle(handle: FileHandle | undefined): Promise<boolean> {
    if (!handle) return true;
    try {
        await handle.close();
        return true;
    } catch {
        return false;
    }
}

function validReleaseDirectory(
    status: BigIntStats,
    identity?: Pick<ReleaseDirectory, "device" | "groupId" | "userId">
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        (status.mode & 0o7777n) === immutableDirectoryMode &&
        (identity === undefined ||
            (status.dev === identity.device &&
                status.gid === identity.groupId &&
                status.uid === identity.userId))
    );
}

async function openReleaseDirectory(
    openPath: string,
    expectedPath: string,
    identity?: Pick<ReleaseDirectory, "device" | "groupId" | "userId">
): Promise<ReleaseDirectory> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(openPath, directoryFlags);
        const [held, atPath, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(expectedPath, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        if (
            canonical !== expectedPath ||
            !validReleaseDirectory(held, identity) ||
            !validReleaseDirectory(atPath, identity) ||
            atPath.dev !== held.dev ||
            atPath.ino !== held.ino
        ) {
            throw installationFailure();
        }
        return Object.freeze({
            device: held.dev,
            groupId: held.gid,
            handle,
            inode: held.ino,
            path: expectedPath,
            userId: held.uid,
        });
    } catch {
        await closeHandle(handle);
        throw installationFailure();
    }
}

function validArtifactPath(artifactPath: string): boolean {
    const segments = artifactPath.split("/");
    return (
        artifactPath.length > 0 &&
        artifactPath.length <= 4096 &&
        !path.isAbsolute(artifactPath) &&
        segments.every(
            (segment) =>
                segment.length > 0 &&
                segment !== "." &&
                segment !== ".." &&
                artifactSegmentPattern.test(segment)
        )
    );
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
    return typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
    const actual = Object.keys(value).toSorted();
    return (
        actual.length === expected.length &&
        expected.every((key, index) => actual[index] === key)
    );
}

function parseManifestArtifacts(
    manifestBytes: Uint8Array,
    releaseId: string
): readonly ReleaseArtifactRecord[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes)
        );
    } catch {
        throw installationFailure();
    }
    const manifest = recordValue(parsed);
    const source = recordValue(manifest?.source);
    if (
        !manifest ||
        !source ||
        manifest.formatVersion !== 1 ||
        source.commitSha !== releaseId ||
        source.treeState !== "clean" ||
        !Array.isArray(manifest.artifacts) ||
        manifest.artifacts.length === 0 ||
        manifest.artifacts.length > maximumArtifactCount
    ) {
        throw installationFailure();
    }
    const records: ReleaseArtifactRecord[] = [];
    for (const value of manifest.artifacts) {
        const record = recordValue(value);
        if (
            !record ||
            !exactKeys(record, ["bytes", "path", "sha256"]) ||
            typeof record.bytes !== "number" ||
            !Number.isSafeInteger(record.bytes) ||
            record.bytes < 1 ||
            typeof record.path !== "string" ||
            !validArtifactPath(record.path) ||
            typeof record.sha256 !== "string" ||
            !artifactShaPattern.test(record.sha256)
        ) {
            throw installationFailure();
        }
        records.push(
            Object.freeze({
                bytes: record.bytes,
                path: record.path,
                sha256: record.sha256,
            })
        );
    }
    if (
        records.some(
            (record, index) =>
                index > 0 && record.path <= (records[index - 1]?.path ?? "")
        )
    ) {
        throw installationFailure();
    }
    const provisioningPaths = records
        .filter(({ path: artifactPath }) => artifactPath.startsWith(provisioningPrefix))
        .map(({ path: artifactPath }) => artifactPath);
    if (
        provisioningPaths.length !==
            logMaintenanceProvisioningReleaseArtifactPaths.length ||
        logMaintenanceProvisioningReleaseArtifactPaths.some(
            (expected, index) => provisioningPaths[index] !== expected
        )
    ) {
        throw installationFailure();
    }
    return Object.freeze(records);
}

async function readHeldFile(
    directory: ReleaseDirectory,
    fileName: string,
    maximumBytes: number,
    expected?: ReleaseArtifactRecord
): Promise<Uint8Array> {
    const anchoredPath = path.join(`/proc/self/fd/${directory.handle.fd}`, fileName);
    const expectedPath = path.join(directory.path, fileName);
    let handle: FileHandle | undefined;
    let output: Uint8Array | undefined;
    try {
        handle = await open(anchoredPath, fileFlags);
        const [held, atPath, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(expectedPath, { bigint: true }),
            realpath(`/proc/self/fd/${handle.fd}`),
        ]);
        const expectedBytes = expected?.bytes;
        if (
            canonical !== expectedPath ||
            !held.isFile() ||
            held.isSymbolicLink() ||
            held.nlink !== 1n ||
            held.uid !== directory.userId ||
            held.gid !== directory.groupId ||
            held.dev !== directory.device ||
            held.size < 1n ||
            held.size > BigInt(maximumBytes) ||
            (held.mode & 0o7777n) !== immutableFileMode ||
            atPath.dev !== held.dev ||
            atPath.ino !== held.ino ||
            (expectedBytes !== undefined && held.size !== BigInt(expectedBytes))
        ) {
            throw installationFailure();
        }
        const bytes = Buffer.alloc(Number(held.size) + 1);
        let offset = 0;
        while (offset < bytes.byteLength) {
            const read = await handle.read(
                bytes,
                offset,
                bytes.byteLength - offset,
                offset
            );
            if (read.bytesRead === 0) break;
            offset += read.bytesRead;
        }
        const [heldAfter, atPathAfter] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(expectedPath, { bigint: true }),
        ]);
        if (
            offset !== Number(held.size) ||
            heldAfter.dev !== held.dev ||
            heldAfter.ino !== held.ino ||
            heldAfter.size !== held.size ||
            heldAfter.ctimeNs !== held.ctimeNs ||
            heldAfter.mtimeNs !== held.mtimeNs ||
            atPathAfter.dev !== held.dev ||
            atPathAfter.ino !== held.ino
        ) {
            throw installationFailure();
        }
        output = bytes.subarray(0, offset);
        if (expected && sha256(output) !== expected.sha256) {
            throw installationFailure();
        }
    } catch {
        await closeHandle(handle);
        throw installationFailure();
    }
    if (!(await closeHandle(handle)) || !output) throw installationFailure();
    return output;
}

async function openReleaseDirectories(
    releaseRoot: string,
    relativeDirectories: readonly string[]
): Promise<ReadonlyMap<string, ReleaseDirectory>> {
    const opened = new Map<string, ReleaseDirectory>();
    const root = await openReleaseDirectory(releaseRoot, releaseRoot);
    opened.set("", root);
    try {
        for (const relativeDirectory of relativeDirectories) {
            let current = root;
            let currentRelative = "";
            for (const segment of relativeDirectory.split("/").filter(Boolean)) {
                currentRelative = currentRelative
                    ? `${currentRelative}/${segment}`
                    : segment;
                const existing = opened.get(currentRelative);
                if (existing) {
                    current = existing;
                    continue;
                }
                const expectedPath = path.join(releaseRoot, currentRelative);
                current = await openReleaseDirectory(
                    path.join(`/proc/self/fd/${current.handle.fd}`, segment),
                    expectedPath,
                    root
                );
                opened.set(currentRelative, current);
            }
        }
        return opened;
    } catch {
        for (const directory of [...opened.values()].toReversed()) {
            await closeHandle(directory.handle);
        }
        throw installationFailure();
    }
}

async function loadProvisioningRelease(
    releaseRoot: string,
    releaseId: string
): Promise<LoadedProvisioningRelease> {
    const provisioningDirectory = provisioningPrefix.slice(0, -1);
    const directories = await openReleaseDirectories(releaseRoot, [
        provisioningDirectory,
    ]);
    let loaded: LoadedProvisioningRelease | undefined;
    let failed = false;
    try {
        const root = directories.get("");
        const source = directories.get(provisioningDirectory);
        if (!root || !source) throw installationFailure();
        const manifestBytes = await readHeldFile(
            root,
            "release-manifest.json",
            maximumManifestBytes
        );
        const artifacts = parseManifestArtifacts(manifestBytes, releaseId);
        const byPath = new Map(artifacts.map((artifact) => [artifact.path, artifact]));
        const sourceBytes = new Map<string, Uint8Array>();
        for (const artifactPath of logMaintenanceProvisioningReleaseArtifactPaths) {
            const record = byPath.get(artifactPath);
            if (!record || record.bytes > maximumProvisioningArtifactBytes) {
                throw installationFailure();
            }
            sourceBytes.set(
                artifactPath,
                await readHeldFile(
                    source,
                    artifactPath.slice(provisioningPrefix.length),
                    maximumProvisioningArtifactBytes,
                    record
                )
            );
        }
        const files = logMaintenanceProvisioningArtifacts.map((policy) => {
            const record = byPath.get(policy.artifactPath);
            const bytes = sourceBytes.get(policy.artifactPath);
            if (!record || !bytes) throw installationFailure();
            return Object.freeze({
                ...policy,
                bytes,
                sha256: record.sha256,
            });
        });
        loaded = Object.freeze({
            files: Object.freeze(files),
            identity: sha256(manifestBytes),
        });
    } catch {
        failed = true;
    }
    for (const directory of [...directories.values()].toReversed()) {
        if (!(await closeHandle(directory.handle))) failed = true;
    }
    if (failed || !loaded) throw installationFailure();
    return loaded;
}

function sameRelease(
    left: LoadedProvisioningRelease,
    right: LoadedProvisioningRelease
): boolean {
    return (
        left.identity === right.identity &&
        left.files.length === right.files.length &&
        left.files.every(
            (file, index) =>
                file.artifactPath === right.files[index]?.artifactPath &&
                file.sha256 === right.files[index]?.sha256 &&
                file.bytes.byteLength === right.files[index]?.bytes.byteLength
        )
    );
}

function requireRoot(): void {
    if (
        process.platform !== "linux" ||
        typeof process.getuid !== "function" ||
        typeof process.getgid !== "function" ||
        process.getuid() !== 0 ||
        process.getgid() !== 0
    ) {
        throw installationFailure();
    }
}

function readNamedArguments(arguments_: readonly string[]): Record<string, string> {
    const values = Object.create(null) as Record<string, string>;
    for (const argument of arguments_) {
        const separator = argument.indexOf("=");
        if (separator <= 2 || !argument.startsWith("--")) {
            throw new TypeError(installationUsage);
        }
        const name = argument.slice(2, separator);
        const value = argument.slice(separator + 1);
        if (!value || Object.hasOwn(values, name)) {
            throw new TypeError(installationUsage);
        }
        values[name] = value;
    }
    return values;
}

/**
 * Parses exactly one immutable release root and its commit identity.
 * @param arguments_ Exact named CLI arguments after the Bun entrypoint.
 * @returns Frozen, canonical release identity arguments.
 */
export function parseInstallLogMaintenanceProvisioningArguments(
    arguments_: readonly string[]
): InstallLogMaintenanceProvisioningArguments {
    if (arguments_.length !== 2) throw new TypeError(installationUsage);
    const values = readNamedArguments(arguments_);
    const releaseId = values["release-id"];
    const releaseRoot = values["release-root"];
    if (
        !releaseId ||
        !commitShaPattern.test(releaseId) ||
        !releaseRoot ||
        !path.isAbsolute(releaseRoot) ||
        releaseRoot.includes("\0") ||
        releaseRoot.length > 4096 ||
        path.resolve(releaseRoot) !== releaseRoot ||
        path.parse(releaseRoot).root === releaseRoot ||
        path.basename(releaseRoot) !== releaseId ||
        Object.keys(values).length !== 2
    ) {
        throw new TypeError(installationUsage);
    }
    return Object.freeze({ releaseId, releaseRoot });
}

/**
 * Verifies one frozen release before and after atomically installing exact root files.
 * This deliberately performs no daemon reload, group mutation, enablement, or service start.
 * @param arguments_ Exact release-root and release-id CLI arguments.
 * @param testHooks Deterministic non-production filesystem and identity boundaries.
 * @returns A redacted installed release identity.
 */
export async function runInstallLogMaintenanceProvisioningCli(
    arguments_: readonly string[],
    testHooks: InstallLogMaintenanceProvisioningTestHooks = {}
): Promise<InstallLogMaintenanceProvisioningResult> {
    const parsed = parseInstallLogMaintenanceProvisioningArguments(arguments_);
    try {
        (testHooks.requireRoot ?? requireRoot)();
        const first = await loadProvisioningRelease(parsed.releaseRoot, parsed.releaseId);
        const preflight = await loadProvisioningRelease(
            parsed.releaseRoot,
            parsed.releaseId
        );
        if (!sameRelease(first, preflight)) throw installationFailure();
        await installLogMaintenanceProvisioningFiles(
            testHooks.destinationRoot ?? "/",
            first.files,
            testHooks.filesystem
        );
        const after = await loadProvisioningRelease(parsed.releaseRoot, parsed.releaseId);
        if (!sameRelease(first, after)) throw installationFailure();
        return Object.freeze({ releaseId: parsed.releaseId, status: "INSTALLED" });
    } catch {
        throw installationFailure();
    }
}

if (import.meta.main) {
    try {
        const result = await runInstallLogMaintenanceProvisioningCli(Bun.argv.slice(2));
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        const message =
            error instanceof TypeError ? error.message : installationFailureMessage;
        process.stderr.write(`${message}\n`);
        process.exitCode = 1;
    }
}
