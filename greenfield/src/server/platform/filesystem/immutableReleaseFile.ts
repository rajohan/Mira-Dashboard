import { constants, type BigIntStats } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

const immutableReleaseFileFailureMessage = "Immutable release file is invalid";
const maximumBrowserAssetBytes = 8 * 1024 * 1024;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const writePermissionBits = 0o222n;

/** Expected immutable artifact identity taken from a verified release manifest. */
export interface ImmutableReleaseFileIdentity {
    readonly bytes: number;
    readonly path: string;
    readonly sha256: string;
}

/** Deterministic mutation boundary exposed only to adversarial tests. */
export interface ImmutableReleaseFileTestHooks {
    readonly afterRead?: (artifactPath: string) => Promise<void> | void;
}

/** Bound no-follow reader for one immutable release's browser tree. */
export interface ImmutableReleaseFileReader {
    read(identity: ImmutableReleaseFileIdentity): Promise<Buffer>;
}

interface ReleaseDirectorySnapshot {
    readonly browser: BigIntStats;
    readonly release: BigIntStats;
    readonly userId: number;
}

interface IntermediateDirectorySnapshot {
    readonly path: string;
    readonly status: BigIntStats;
}

function immutableReleaseFileFailure(): Error {
    return new Error(immutableReleaseFileFailureMessage);
}

function currentUserId(): number {
    if (process.platform !== "linux" || typeof process.getuid !== "function") {
        throw immutableReleaseFileFailure();
    }
    return process.getuid();
}

function sameSnapshot(left: BigIntStats, right: BigIntStats): boolean {
    return (
        left.dev === right.dev &&
        left.ino === right.ino &&
        left.size === right.size &&
        left.ctimeNs === right.ctimeNs &&
        left.mtimeNs === right.mtimeNs
    );
}

function validImmutableDirectory(
    status: BigIntStats,
    userId: number,
    expectedDevice?: bigint
): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & writePermissionBits) === 0n &&
        (expectedDevice === undefined || status.dev === expectedDevice)
    );
}

function validImmutableFile(
    status: BigIntStats,
    expectedBytes: number,
    snapshot: ReleaseDirectorySnapshot
): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.uid === BigInt(snapshot.userId) &&
        status.dev === snapshot.release.dev &&
        status.size === BigInt(expectedBytes) &&
        (status.mode & writePermissionBits) === 0n
    );
}

function validArtifactIdentity(identity: ImmutableReleaseFileIdentity): boolean {
    return (
        identity.path.startsWith("browser/") &&
        !identity.path.includes("\0") &&
        !identity.path.includes("\\") &&
        !identity.path
            .split("/")
            .some(
                (segment) => segment.length === 0 || segment === "." || segment === ".."
            ) &&
        Number.isSafeInteger(identity.bytes) &&
        identity.bytes > 0 &&
        identity.bytes <= maximumBrowserAssetBytes &&
        /^[a-f\d]{64}$/u.test(identity.sha256)
    );
}

async function snapshotIntermediateDirectories(
    browserRoot: string,
    snapshot: ReleaseDirectorySnapshot,
    identity: ImmutableReleaseFileIdentity
): Promise<readonly IntermediateDirectorySnapshot[]> {
    const relativeDirectory = path.posix.dirname(identity.path);
    const segments = relativeDirectory.split("/").slice(1);
    const directories: IntermediateDirectorySnapshot[] = [];
    let current = browserRoot;
    for (const segment of segments) {
        current = path.join(current, segment);
        const [canonical, status] = await Promise.all([
            realpath(current),
            lstat(current, { bigint: true }),
        ]);
        if (
            canonical !== current ||
            !validImmutableDirectory(status, snapshot.userId, snapshot.release.dev)
        ) {
            throw immutableReleaseFileFailure();
        }
        directories.push(Object.freeze({ path: current, status }));
    }
    return Object.freeze(directories);
}

function sha256(bytes: Uint8Array): string {
    return new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
}

async function closeFile(file: FileHandle | undefined): Promise<boolean> {
    if (!file) return true;
    try {
        await file.close();
        return true;
    } catch {
        return false;
    }
}

async function readExactFile(
    releaseRoot: string,
    browserRoot: string,
    snapshot: ReleaseDirectorySnapshot,
    identity: ImmutableReleaseFileIdentity,
    testHooks: ImmutableReleaseFileTestHooks
): Promise<Buffer> {
    if (!validArtifactIdentity(identity)) throw immutableReleaseFileFailure();
    const filePath = path.join(releaseRoot, identity.path);
    if (!filePath.startsWith(`${browserRoot}${path.sep}`)) {
        throw immutableReleaseFileFailure();
    }

    let file: FileHandle | undefined;
    let contents: Buffer | undefined;
    let failed = false;
    try {
        const intermediate = await snapshotIntermediateDirectories(
            browserRoot,
            snapshot,
            identity
        );
        file = await open(filePath, readFlags);
        const held = await file.stat({ bigint: true });
        const descriptorPath = await realpath(`/proc/self/fd/${file.fd}`);
        if (
            descriptorPath !== filePath ||
            !validImmutableFile(held, identity.bytes, snapshot)
        ) {
            throw immutableReleaseFileFailure();
        }

        const buffer = Buffer.alloc(identity.bytes + 1);
        let bytesRead = 0;
        while (bytesRead < buffer.byteLength) {
            const result = await file.read(
                buffer,
                bytesRead,
                buffer.byteLength - bytesRead,
                bytesRead
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        await testHooks.afterRead?.(identity.path);
        const [heldAfter, pathAfter, browserAfter, releaseAfter, intermediateAfter] =
            await Promise.all([
                file.stat({ bigint: true }),
                lstat(filePath, { bigint: true }),
                lstat(browserRoot, { bigint: true }),
                lstat(releaseRoot, { bigint: true }),
                Promise.all(
                    intermediate.map((directory) =>
                        lstat(directory.path, { bigint: true })
                    )
                ),
            ]);
        if (
            bytesRead !== identity.bytes ||
            !sameSnapshot(held, heldAfter) ||
            !sameSnapshot(held, pathAfter) ||
            !sameSnapshot(snapshot.browser, browserAfter) ||
            !sameSnapshot(snapshot.release, releaseAfter) ||
            intermediate.some(
                (directory, index) =>
                    !sameSnapshot(directory.status, intermediateAfter[index]!) ||
                    !validImmutableDirectory(
                        intermediateAfter[index]!,
                        snapshot.userId,
                        snapshot.release.dev
                    )
            ) ||
            sha256(buffer.subarray(0, bytesRead)) !== identity.sha256
        ) {
            throw immutableReleaseFileFailure();
        }
        contents = buffer.subarray(0, bytesRead);
    } catch {
        failed = true;
    }
    if (!(await closeFile(file))) failed = true;
    if (failed || contents === undefined) throw immutableReleaseFileFailure();
    return contents;
}

/**
 * Revalidates one immutable runtime release and binds a browser-artifact reader to it.
 * @param releaseRoot Canonical exact release directory, never a mutable pointer.
 * @param testHooks Deterministic adversarial hooks used only by tests.
 * @returns Reader that verifies manifest size/hash and filesystem identity per request.
 */
export async function createImmutableReleaseFileReader(
    releaseRoot: string,
    testHooks: ImmutableReleaseFileTestHooks = {}
): Promise<ImmutableReleaseFileReader> {
    if (
        !path.isAbsolute(releaseRoot) ||
        releaseRoot.includes("\0") ||
        path.resolve(releaseRoot) !== releaseRoot
    ) {
        throw immutableReleaseFileFailure();
    }
    try {
        const userId = currentUserId();
        const browserRoot = path.join(releaseRoot, "browser");
        const [canonicalRelease, canonicalBrowser, release, browser] = await Promise.all([
            realpath(releaseRoot),
            realpath(browserRoot),
            lstat(releaseRoot, { bigint: true }),
            lstat(browserRoot, { bigint: true }),
        ]);
        if (
            canonicalRelease !== releaseRoot ||
            canonicalBrowser !== browserRoot ||
            !validImmutableDirectory(release, userId) ||
            !validImmutableDirectory(browser, userId, release.dev)
        ) {
            throw immutableReleaseFileFailure();
        }
        const directorySnapshot = Object.freeze({ browser, release, userId });
        return Object.freeze({
            read: (identity: ImmutableReleaseFileIdentity) =>
                readExactFile(
                    releaseRoot,
                    browserRoot,
                    directorySnapshot,
                    identity,
                    testHooks
                ),
        });
    } catch {
        throw immutableReleaseFileFailure();
    }
}
