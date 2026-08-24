import { constants, type BigIntStats } from "node:fs";
import {
    chmod,
    lstat,
    mkdir,
    open,
    realpath,
    rename,
    rm,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import type { DashboardDeploymentLease } from "./deploymentLease.ts";
import type { PreparedProductionDeliveryPaths } from "./productionDeliveryFilesystem.ts";
import type { ReleaseRuntimeIdentity } from "./releaseIdentity.ts";

const productionRuntimeFailureMessage = "Production Bun runtime installation failed";
const maximumRuntimeBytes = 256 * 1024 * 1024;
const maximumProbeBytes = 512;
const copyBufferBytes = 1024 * 1024;
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;
const immutableDirectoryMode = 0o500;
const immutableFileMode = 0o500;
const sourceFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const destinationFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const runtimeIdentitySchema = v.strictObject({
    revision: v.pipe(v.string(), v.regex(/^[a-f\d]{40}$/u)),
    version: v.pipe(v.string(), v.regex(/^\d+\.\d+\.\d+$/u)),
});

/** Installed exact Bun runtime below the Dashboard project root. */
export interface InstalledProductionRuntime {
    readonly executable: string;
    readonly identity: ReleaseRuntimeIdentity;
}

/** Read-only runtime probe boundary used by activation verification tests. */
export interface ProductionRuntimeVerificationDependencies {
    readonly probeRuntime?: (executable: string) => Promise<ReleaseRuntimeIdentity>;
}

/** Runtime probe and mutation boundaries exposed only to focused tests. */
export interface ProductionRuntimeDependencies {
    readonly afterCopy?: (destination: string) => Promise<void> | void;
    readonly probeRuntime?: (executable: string) => Promise<ReleaseRuntimeIdentity>;
    readonly sourceExecutable?: string;
}

interface FileSnapshot {
    readonly ctimeNs: bigint;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly mtimeNs: bigint;
    readonly size: bigint;
    readonly uid: bigint;
}

function productionRuntimeFailure(): Error {
    return new Error(productionRuntimeFailureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function snapshot(status: BigIntStats): FileSnapshot {
    if (
        typeof process.getuid !== "function" ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        status.size <= 0n ||
        status.size > BigInt(maximumRuntimeBytes)
    ) {
        throw productionRuntimeFailure();
    }
    return Object.freeze({
        ctimeNs: status.ctimeNs,
        dev: status.dev,
        ino: status.ino,
        mtimeNs: status.mtimeNs,
        size: status.size,
        uid: status.uid,
    });
}

function sameSnapshot(expected: FileSnapshot, actual: FileSnapshot): boolean {
    return (
        expected.ctimeNs === actual.ctimeNs &&
        expected.dev === actual.dev &&
        expected.ino === actual.ino &&
        expected.mtimeNs === actual.mtimeNs &&
        expected.size === actual.size &&
        expected.uid === actual.uid
    );
}

function sameRuntimeIdentity(
    expected: ReleaseRuntimeIdentity,
    actual: ReleaseRuntimeIdentity
): boolean {
    return expected.revision === actual.revision && expected.version === actual.version;
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

async function readBoundedProbeOutput(
    stream: ReadableStream<Uint8Array>
): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
        while (true) {
            const result = await reader.read();
            if (result.done) break;
            bytes += result.value.byteLength;
            if (bytes > maximumProbeBytes) throw productionRuntimeFailure();
            chunks.push(result.value);
        }
    } finally {
        reader.releaseLock();
    }
    const output = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
        output.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return output;
}

async function probeProductionRuntime(
    executable: string
): Promise<ReleaseRuntimeIdentity> {
    const child = Bun.spawn(
        [
            executable,
            "-e",
            "process.stdout.write(JSON.stringify({revision:Bun.revision,version:Bun.version}))",
        ],
        {
            env: { PATH: "/usr/bin:/bin" },
            signal: AbortSignal.timeout(10_000),
            stderr: "ignore",
            stdin: "ignore",
            stdout: "pipe",
        }
    );
    try {
        const output = await readBoundedProbeOutput(child.stdout);
        if ((await child.exited) !== 0) throw productionRuntimeFailure();
        const text = new TextDecoder("utf-8", { fatal: true }).decode(output);
        const parsed: unknown = JSON.parse(text);
        return Object.freeze(v.parse(runtimeIdentitySchema, parsed));
    } catch {
        child.kill();
        throw productionRuntimeFailure();
    }
}

async function ensurePrivateDirectory(parent: string, name: string): Promise<string> {
    if (typeof process.getuid !== "function") throw productionRuntimeFailure();
    const directory = path.join(parent, name);
    try {
        await mkdir(directory, { mode: privateDirectoryMode });
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw productionRuntimeFailure();
    }
    try {
        const [canonical, status] = await Promise.all([
            realpath(directory),
            lstat(directory, { bigint: true }),
        ]);
        if (
            canonical !== directory ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid()) ||
            (status.mode & 0o700n) !== 0o700n
        ) {
            throw productionRuntimeFailure();
        }
        await chmod(directory, privateDirectoryMode);
        const after = await lstat(directory, { bigint: true });
        if (
            after.dev !== status.dev ||
            after.ino !== status.ino ||
            (after.mode & 0o7777n) !== 0o700n
        ) {
            throw productionRuntimeFailure();
        }
        return directory;
    } catch {
        throw productionRuntimeFailure();
    }
}

async function assertPrivateRuntimeRoot(directory: string): Promise<void> {
    if (typeof process.getuid !== "function") throw productionRuntimeFailure();
    const [canonical, status] = await Promise.all([
        realpath(directory),
        lstat(directory, { bigint: true }),
    ]);
    if (
        canonical !== directory ||
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        status.uid !== BigInt(process.getuid()) ||
        (status.mode & 0o7777n) !== 0o700n
    ) {
        throw productionRuntimeFailure();
    }
}

async function pathExists(candidate: string): Promise<boolean> {
    try {
        await lstat(candidate);
        return true;
    } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw productionRuntimeFailure();
    }
}

async function hashFileHandle(
    handle: FileHandle,
    expectedBytes: number
): Promise<string> {
    const hasher = new Bun.CryptoHasher("sha256");
    const buffer = Buffer.alloc(Math.min(copyBufferBytes, expectedBytes));
    let offset = 0;
    while (offset < expectedBytes) {
        const length = Math.min(buffer.byteLength, expectedBytes - offset);
        const result = await handle.read(buffer, 0, length, offset);
        if (result.bytesRead <= 0) throw productionRuntimeFailure();
        hasher.update(buffer.subarray(0, result.bytesRead));
        offset += result.bytesRead;
    }
    return hasher.digest("hex");
}

async function copyRuntimeExecutable(
    sourceExecutable: string,
    destination: string,
    afterCopy?: (destination: string) => Promise<void> | void
): Promise<void> {
    let source: FileHandle | undefined;
    let target: FileHandle | undefined;
    let failed = false;
    try {
        source = await open(sourceExecutable, sourceFlags);
        const heldStatus = await source.stat({ bigint: true });
        const heldBefore = snapshot(heldStatus);
        const canonical = await realpath(`/proc/self/fd/${source.fd}`);
        if (canonical !== sourceExecutable || (heldStatus.mode & 0o100n) === 0n) {
            throw productionRuntimeFailure();
        }

        target = await open(destination, destinationFlags, privateFileMode);
        const buffer = Buffer.alloc(Math.min(copyBufferBytes, Number(heldBefore.size)));
        const sourceHasher = new Bun.CryptoHasher("sha256");
        let offset = 0;
        while (offset < Number(heldBefore.size)) {
            const length = Math.min(buffer.byteLength, Number(heldBefore.size) - offset);
            const read = await source.read(buffer, 0, length, offset);
            if (read.bytesRead <= 0) throw productionRuntimeFailure();
            sourceHasher.update(buffer.subarray(0, read.bytesRead));
            let written = 0;
            while (written < read.bytesRead) {
                const write = await target.write(
                    buffer,
                    written,
                    read.bytesRead - written,
                    offset + written
                );
                if (write.bytesWritten <= 0) throw productionRuntimeFailure();
                written += write.bytesWritten;
            }
            offset += read.bytesRead;
        }
        await target.sync();
        await afterCopy?.(destination);
        const [heldAfter, sourceAfter, targetStatus] = await Promise.all([
            source.stat({ bigint: true }),
            lstat(sourceExecutable, { bigint: true }),
            target.stat({ bigint: true }),
        ]);
        if (
            !sameSnapshot(heldBefore, snapshot(heldAfter)) ||
            !sameSnapshot(heldBefore, snapshot(sourceAfter)) ||
            targetStatus.size !== heldBefore.size ||
            targetStatus.nlink !== 1n ||
            targetStatus.uid !== heldBefore.uid
        ) {
            throw productionRuntimeFailure();
        }
        const destinationHash = await hashFileHandle(target, Number(heldBefore.size));
        if (destinationHash !== sourceHasher.digest("hex")) {
            throw productionRuntimeFailure();
        }
        await target.chmod(immutableFileMode);
        await target.sync();
    } catch {
        failed = true;
    }
    const [sourceClosed, targetClosed] = await Promise.all([
        closeHandle(source),
        closeHandle(target),
    ]);
    if (failed || !sourceClosed || !targetClosed) throw productionRuntimeFailure();
}

async function assertInstalledRuntimeFile(executable: string): Promise<void> {
    if (typeof process.getuid !== "function") throw productionRuntimeFailure();
    const [canonical, status, parentStatus] = await Promise.all([
        realpath(executable),
        lstat(executable, { bigint: true }),
        lstat(path.dirname(executable), { bigint: true }),
    ]);
    if (
        canonical !== executable ||
        !status.isFile() ||
        status.isSymbolicLink() ||
        status.nlink !== 1n ||
        status.uid !== BigInt(process.getuid()) ||
        status.dev !== parentStatus.dev ||
        status.size <= 0n ||
        status.size > BigInt(maximumRuntimeBytes) ||
        (status.mode & 0o7777n) !== 0o500n ||
        !parentStatus.isDirectory() ||
        parentStatus.isSymbolicLink() ||
        parentStatus.uid !== BigInt(process.getuid()) ||
        (parentStatus.mode & 0o7777n) !== 0o500n
    ) {
        throw productionRuntimeFailure();
    }
}

async function removeOwnedRuntimeCandidate(
    bunRoot: string,
    stageRoot: string,
    stageName: string
): Promise<void> {
    if (path.dirname(stageRoot) !== bunRoot || path.basename(stageRoot) !== stageName) {
        throw productionRuntimeFailure();
    }
    try {
        const status = await lstat(stageRoot, { bigint: true });
        if (
            typeof process.getuid !== "function" ||
            !status.isDirectory() ||
            status.isSymbolicLink() ||
            status.uid !== BigInt(process.getuid())
        ) {
            throw productionRuntimeFailure();
        }
        await chmod(stageRoot, privateDirectoryMode);
        const executable = path.join(stageRoot, "bun");
        const file = await lstat(executable, { bigint: true }).catch(() => null);
        if (file) {
            if (
                !file.isFile() ||
                file.isSymbolicLink() ||
                file.nlink !== 1n ||
                file.uid !== BigInt(process.getuid())
            ) {
                throw productionRuntimeFailure();
            }
            await chmod(executable, privateFileMode);
        }
        await rm(stageRoot, { force: false, recursive: true });
    } catch (error) {
        if (errorCode(error) !== "ENOENT") throw productionRuntimeFailure();
    }
}

/**
 * Installs the exact Bun executable represented by a release under project-local runtimes.
 * @param lease Active wider deployment transition lease.
 * @param paths Revalidated production delivery paths.
 * @param expectedIdentity Exact runtime identity from the release manifest.
 * @param dependencies Injectable source/probe boundaries used by focused tests.
 * @returns Idempotently installed immutable runtime executable.
 */
export async function installProductionRuntime(
    lease: DashboardDeploymentLease,
    paths: PreparedProductionDeliveryPaths,
    expectedIdentity: ReleaseRuntimeIdentity,
    dependencies: ProductionRuntimeDependencies = {}
): Promise<InstalledProductionRuntime> {
    if (
        lease.stateDirectory !== paths.stateDirectory ||
        paths.runtimesDirectory !== path.join(paths.productionDirectory, "runtimes") ||
        !v.is(runtimeIdentitySchema, expectedIdentity)
    ) {
        throw productionRuntimeFailure();
    }
    const probe = dependencies.probeRuntime ?? probeProductionRuntime;
    const sourceExecutable = dependencies.sourceExecutable ?? process.execPath;
    let ownedRoot: string | undefined;
    let ownedName: string | undefined;
    try {
        await assertPrivateRuntimeRoot(paths.runtimesDirectory);
        if (
            !path.isAbsolute(sourceExecutable) ||
            path.resolve(sourceExecutable) !== sourceExecutable ||
            (await realpath(sourceExecutable)) !== sourceExecutable ||
            !sameRuntimeIdentity(expectedIdentity, await probe(sourceExecutable))
        ) {
            throw productionRuntimeFailure();
        }
        const bunRoot = await ensurePrivateDirectory(paths.runtimesDirectory, "bun");
        const finalRoot = path.join(bunRoot, expectedIdentity.revision);
        const finalExecutable = path.join(finalRoot, "bun");
        if (await pathExists(finalRoot)) {
            await assertInstalledRuntimeFile(finalExecutable);
            const observed = await probe(finalExecutable);
            if (!sameRuntimeIdentity(expectedIdentity, observed)) {
                throw productionRuntimeFailure();
            }
            return Object.freeze({ executable: finalExecutable, identity: observed });
        }

        const stageName = `.stage-${expectedIdentity.revision}-${Bun.randomUUIDv7()}`;
        const stageRoot = path.join(bunRoot, stageName);
        ownedRoot = stageRoot;
        ownedName = stageName;
        await mkdir(stageRoot, { mode: privateDirectoryMode });
        const stageExecutable = path.join(stageRoot, "bun");
        await copyRuntimeExecutable(
            sourceExecutable,
            stageExecutable,
            dependencies.afterCopy
        );
        const stagedIdentity = await probe(stageExecutable);
        if (!sameRuntimeIdentity(expectedIdentity, stagedIdentity)) {
            throw productionRuntimeFailure();
        }
        await chmod(stageRoot, immutableDirectoryMode);
        await rename(stageRoot, finalRoot);
        ownedRoot = finalRoot;
        ownedName = expectedIdentity.revision;
        await assertInstalledRuntimeFile(finalExecutable);
        const observed = await probe(finalExecutable);
        if (!sameRuntimeIdentity(expectedIdentity, observed)) {
            throw productionRuntimeFailure();
        }
        ownedRoot = undefined;
        ownedName = undefined;
        return Object.freeze({ executable: finalExecutable, identity: observed });
    } catch {
        if (ownedRoot && ownedName) {
            try {
                await removeOwnedRuntimeCandidate(
                    path.dirname(ownedRoot),
                    ownedRoot,
                    ownedName
                );
            } catch {
                // Preserve the fixed runtime-installation failure and bounded evidence.
            }
        }
        throw productionRuntimeFailure();
    }
}

/**
 * Revalidates one immutable project-local Bun runtime before process execution.
 * @param paths Exact prepared production delivery roots.
 * @param runtime Previously installed runtime identity and executable.
 * @param dependencies Injectable probe boundary for focused tests.
 * @returns The exact observed identity after path and executable verification.
 */
export async function verifyInstalledProductionRuntime(
    paths: PreparedProductionDeliveryPaths,
    runtime: InstalledProductionRuntime,
    dependencies: ProductionRuntimeVerificationDependencies = {}
): Promise<ReleaseRuntimeIdentity> {
    try {
        if (
            !v.is(runtimeIdentitySchema, runtime.identity) ||
            runtime.executable !==
                path.join(
                    paths.runtimesDirectory,
                    "bun",
                    runtime.identity.revision,
                    "bun"
                )
        ) {
            throw productionRuntimeFailure();
        }
        await assertPrivateRuntimeRoot(paths.runtimesDirectory);
        await assertInstalledRuntimeFile(runtime.executable);
        const observed = await (dependencies.probeRuntime ?? probeProductionRuntime)(
            runtime.executable
        );
        if (!sameRuntimeIdentity(runtime.identity, observed)) {
            throw productionRuntimeFailure();
        }
        return observed;
    } catch {
        throw productionRuntimeFailure();
    }
}

/**
 * Reconstructs and verifies one installed runtime named by immutable activation state.
 * @param paths Exact prepared production delivery roots.
 * @param identity Runtime identity from the verified production release manifest.
 * @param dependencies Injectable probe boundary for focused tests.
 * @returns Verified installed runtime executable and identity.
 */
export async function loadInstalledProductionRuntime(
    paths: PreparedProductionDeliveryPaths,
    identity: ReleaseRuntimeIdentity,
    dependencies: ProductionRuntimeVerificationDependencies = {}
): Promise<InstalledProductionRuntime> {
    const runtime = Object.freeze({
        executable: path.join(paths.runtimesDirectory, "bun", identity.revision, "bun"),
        identity,
    });
    await verifyInstalledProductionRuntime(paths, runtime, dependencies);
    return runtime;
}
