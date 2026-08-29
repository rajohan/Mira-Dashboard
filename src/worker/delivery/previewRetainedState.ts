import { constants, type BigIntStats } from "node:fs";
import {
    lstat,
    open,
    readdir,
    rename,
    rmdir,
    unlink,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    deliveryCommitShaSchema,
    deliveryResourceRevisionSchema,
} from "../../contracts/delivery.ts";
import { positiveSafeIntegerSchema } from "../../shared/validation.ts";
import { PreviewHostError } from "./previewTypes.ts";

const metadataFormatVersion = 1 as const;
const ownerPattern = /^pr-([1-9]\d*)\.json$/u;
const retiredStatePattern = /^\.retired-pr-([1-9]\d*)-[0-9a-f-]{36}$/u;
const stagedOwnerPattern = /^\.owner-([1-9]\d*)-[0-9a-f-]{36}\.tmp$/u;
const reconciliationGateFileName = "reconciliation-gate.json";
const stagedReconciliationGatePattern = /^\.reconciliation-gate-[0-9a-f-]{36}\.tmp$/u;
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fileCreateFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;
const descriptorInfoMaximumBytes = 4096;
const metadataMaximumBytes = 4096;
const maximumRootEntries = 256;
const maximumTreeEntries = 4096;
const maximumTreeDepth = 20;
export const previewRetainedReconciliationIntervalMs = 6 * 60 * 60 * 1000;

const timestampSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const metadataSchema = v.strictObject({
    expectedHeadSha: deliveryCommitShaSchema,
    formatVersion: v.literal(metadataFormatVersion),
    number: positiveSafeIntegerSchema("Preview owner number is invalid"),
    previewRevision: deliveryResourceRevisionSchema,
    reconciledAtMs: timestampSchema,
});
export type PreviewRetainedOwner = v.InferOutput<typeof metadataSchema>;
const reconciliationGateSchema = v.strictObject({
    checkedAtMs: timestampSchema,
    formatVersion: v.literal(metadataFormatVersion),
});
type PreviewRetainedReconciliationGate = v.InferOutput<typeof reconciliationGateSchema>;

interface OpenedDirectory {
    readonly device: bigint;
    readonly handle: FileHandle;
    readonly inode: bigint;
    readonly mountId: bigint;
}

function fail(): never {
    throw new PreviewHostError({ reason: "path-unsafe" });
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

function validDirectory(status: BigIntStats, device?: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        (device === undefined || status.dev === device) &&
        (status.mode & 0o7777n) === 0o700n
    );
}

function validFile(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device &&
        status.nlink === 1n &&
        (status.mode & 0o7777n) === 0o600n
    );
}

function validSocket(status: BigIntStats, device: bigint): boolean {
    return (
        typeof process.getuid === "function" &&
        status.isSocket() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(process.getuid()) &&
        status.dev === device &&
        status.nlink === 1n &&
        (status.mode & 0o077n) === 0n
    );
}

async function mountId(fileDescriptor: number): Promise<bigint> {
    try {
        const text = await Bun.file(`/proc/self/fdinfo/${fileDescriptor}`).text();
        if (text.length === 0 || text.length > descriptorInfoMaximumBytes) fail();
        const matches = [...text.matchAll(/^mnt_id:\s*(\d+)$/gmu)];
        if (matches.length !== 1 || !matches[0]?.[1]) fail();
        const value = BigInt(matches[0][1]);
        if (value <= 0n) fail();
        return value;
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        return fail();
    }
}

async function openDirectory(
    directory: string,
    expected?: Pick<OpenedDirectory, "device" | "inode" | "mountId">
): Promise<OpenedDirectory> {
    let handle: FileHandle | undefined;
    try {
        handle = await open(directory, directoryFlags);
        const [held, named, observedMount] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            mountId(handle.fd),
        ]);
        if (
            !validDirectory(held, expected?.device) ||
            !validDirectory(named, expected?.device) ||
            held.dev !== named.dev ||
            held.ino !== named.ino ||
            (expected !== undefined &&
                (held.ino !== expected.inode || observedMount !== expected.mountId))
        ) {
            fail();
        }
        return Object.freeze({
            device: held.dev,
            handle,
            inode: held.ino,
            mountId: observedMount,
        });
    } catch (error) {
        await handle?.close().catch(() => {});
        if (error instanceof PreviewHostError) throw error;
        return fail();
    }
}

async function readOwnerFromRoot(
    root: OpenedDirectory,
    number: number
): Promise<PreviewRetainedOwner | undefined> {
    const name = `pr-${number}.json`;
    const candidate = path.join(`/proc/self/fd/${root.handle.fd}`, name);
    let file: FileHandle | undefined;
    try {
        file = await open(candidate, fileReadFlags);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return undefined;
        return fail();
    }
    try {
        const before = await file.stat({ bigint: true });
        if (
            !validFile(before, root.device) ||
            before.size <= 0n ||
            before.size > BigInt(metadataMaximumBytes)
        ) {
            fail();
        }
        const bytes = await file.readFile();
        const after = await file.stat({ bigint: true });
        if (
            BigInt(bytes.length) !== before.size ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs
        ) {
            fail();
        }
        const parsed = v.parse(
            metadataSchema,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
        if (parsed.number !== number) fail();
        return parsed;
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        return fail();
    } finally {
        await file.close();
    }
}

async function readReconciliationGateFromRoot(
    root: OpenedDirectory
): Promise<PreviewRetainedReconciliationGate | undefined> {
    const candidate = path.join(
        `/proc/self/fd/${root.handle.fd}`,
        reconciliationGateFileName
    );
    let file: FileHandle | undefined;
    try {
        file = await open(candidate, fileReadFlags);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        return fail();
    }
    try {
        const before = await file.stat({ bigint: true });
        if (
            !validFile(before, root.device) ||
            before.size <= 0n ||
            before.size > BigInt(metadataMaximumBytes)
        ) {
            fail();
        }
        const bytes = await file.readFile();
        const after = await file.stat({ bigint: true });
        if (
            BigInt(bytes.length) !== before.size ||
            after.ino !== before.ino ||
            after.size !== before.size ||
            after.mtimeNs !== before.mtimeNs
        ) {
            fail();
        }
        return v.parse(
            reconciliationGateSchema,
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes))
        );
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        return fail();
    } finally {
        await file.close();
    }
}

async function writeReconciliationGate(
    root: OpenedDirectory,
    checkedAtMs: number
): Promise<void> {
    const current = await readReconciliationGateFromRoot(root);
    if (current !== undefined && checkedAtMs < current.checkedAtMs) fail();
    const parsed = v.parse(reconciliationGateSchema, {
        checkedAtMs,
        formatVersion: metadataFormatVersion,
    });
    const descriptor = `/proc/self/fd/${root.handle.fd}`;
    const destination = path.join(descriptor, reconciliationGateFileName);
    const temporary = path.join(
        descriptor,
        `.reconciliation-gate-${Bun.randomUUIDv7()}.tmp`
    );
    const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
    if (bytes.length > metadataMaximumBytes) fail();
    let file: FileHandle | undefined;
    try {
        file = await open(temporary, fileCreateFlags, 0o600);
        await file.chmod(0o600);
        await file.writeFile(bytes);
        await file.sync();
        const metadata = await file.stat({ bigint: true });
        if (!validFile(metadata, root.device) || metadata.size !== BigInt(bytes.length)) {
            fail();
        }
        await rename(temporary, destination);
        await root.handle.sync();
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        fail();
    } finally {
        await file?.close().catch(() => {});
        await unlink(temporary).catch((error) => {
            if (errorCode(error) !== "ENOENT") fail();
        });
    }
}

export async function readPreviewRetainedOwner(
    ownersRoot: string,
    number: number
): Promise<PreviewRetainedOwner | undefined> {
    if (!Number.isSafeInteger(number) || number <= 0) fail();
    const root = await openDirectory(ownersRoot);
    try {
        return await readOwnerFromRoot(root, number);
    } finally {
        await root.handle.close();
    }
}

/**
 * Atomically writes exact PR/head authority outside the candidate-writable state.
 * @param ownersRoot Private host-only owner root.
 * @param owner Exact retained preview identity.
 */
export async function writePreviewRetainedOwner(
    ownersRoot: string,
    owner: PreviewRetainedOwner
): Promise<void> {
    const parsed = v.parse(metadataSchema, owner);
    const root = await openDirectory(ownersRoot);
    const descriptor = `/proc/self/fd/${root.handle.fd}`;
    const destination = path.join(descriptor, `pr-${parsed.number}.json`);
    const temporary = path.join(
        descriptor,
        `.owner-${parsed.number}-${Bun.randomUUIDv7()}.tmp`
    );
    let file: FileHandle | undefined;
    try {
        const current = await readOwnerFromRoot(root, parsed.number);
        if (current !== undefined && current.number !== parsed.number) fail();
        const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
        if (bytes.length > metadataMaximumBytes) fail();
        file = await open(temporary, fileCreateFlags, 0o600);
        await file.chmod(0o600);
        await file.writeFile(bytes);
        await file.sync();
        const metadata = await file.stat({ bigint: true });
        if (!validFile(metadata, root.device) || metadata.size !== BigInt(bytes.length)) {
            fail();
        }
        await rename(temporary, destination);
        await root.handle.sync();
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        fail();
    } finally {
        await file?.close().catch(() => {});
        await unlink(temporary).catch((error) => {
            if (errorCode(error) !== "ENOENT") fail();
        });
        await root.handle.close();
    }
}

/**
 * Selects at most one due retained owner, fairly ordered by last reconciliation.
 * @param ownersRoot Private host-only owner root.
 * @param nowMs Current trusted epoch time.
 * @returns Oldest due retained owner, if any.
 */
export async function nextPreviewRetainedOwner(
    ownersRoot: string,
    nowMs: number
): Promise<PreviewRetainedOwner | undefined> {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) fail();
    const root = await openDirectory(ownersRoot);
    try {
        const entries = await readdir(`/proc/self/fd/${root.handle.fd}`, {
            withFileTypes: true,
        });
        if (entries.length > maximumRootEntries) fail();
        const owners: PreviewRetainedOwner[] = [];
        for (const entry of entries) {
            if (entry.name === reconciliationGateFileName) {
                if (!entry.isFile()) fail();
                continue;
            }
            const match = ownerPattern.exec(entry.name);
            if (match === null) {
                if (
                    !stagedOwnerPattern.test(entry.name) &&
                    !stagedReconciliationGatePattern.test(entry.name)
                ) {
                    fail();
                }
                continue;
            }
            if (!entry.isFile()) fail();
            const owner = await readOwnerFromRoot(root, Number(match[1]));
            if (owner === undefined) fail();
            owners.push(owner);
        }
        const next = owners
            .filter(
                ({ reconciledAtMs }) =>
                    nowMs - reconciledAtMs >= previewRetainedReconciliationIntervalMs
            )
            .toSorted(
                (left, right) =>
                    left.reconciledAtMs - right.reconciledAtMs ||
                    left.number - right.number
            )[0];
        if (next === undefined) return;
        const gate = await readReconciliationGateFromRoot(root);
        if (
            gate !== undefined &&
            nowMs - gate.checkedAtMs < previewRetainedReconciliationIntervalMs
        ) {
            return;
        }
        // Claim the global six-hour read budget durably before the provider call.
        await writeReconciliationGate(root, nowMs);
        return next;
    } finally {
        await root.handle.close();
    }
}

async function retireAndUnlinkFile(
    root: OpenedDirectory,
    name: string,
    expectedInode: bigint
): Promise<void> {
    const descriptor = `/proc/self/fd/${root.handle.fd}`;
    const source = path.join(descriptor, name);
    const retired = path.join(descriptor, `.reap-${Bun.randomUUIDv7()}`);
    const handle = await open(source, fileReadFlags).catch(() => fail());
    try {
        const held = await handle.stat({ bigint: true });
        if (!validFile(held, root.device) || held.ino !== expectedInode) {
            fail();
        }
        await rename(source, retired);
        await root.handle.sync();
        const named = await lstat(retired, { bigint: true });
        if (!validFile(named, root.device) || named.ino !== held.ino) fail();
        await unlink(retired);
        await root.handle.sync();
    } finally {
        await handle.close();
    }
}

async function emptyDirectory(
    root: OpenedDirectory,
    directoryPath: string,
    expectedInode: bigint,
    depth: number,
    observed: { count: number }
): Promise<void> {
    if (depth > maximumTreeDepth) fail();
    const directory = await openDirectory(directoryPath, {
        device: root.device,
        inode: expectedInode,
        mountId: root.mountId,
    });
    try {
        const descriptor = `/proc/self/fd/${directory.handle.fd}`;
        for (const entry of await readdir(descriptor, { withFileTypes: true })) {
            observed.count += 1;
            if (observed.count > maximumTreeEntries) fail();
            const child = path.join(descriptor, entry.name);
            const metadata = await lstat(child, { bigint: true });
            if (validDirectory(metadata, root.device)) {
                await emptyDirectory(root, child, metadata.ino, depth + 1, observed);
                const current = await lstat(child, { bigint: true });
                if (
                    !validDirectory(current, root.device) ||
                    current.ino !== metadata.ino
                ) {
                    fail();
                }
                await rmdir(child);
            } else if (validFile(metadata, root.device)) {
                const retired = path.join(descriptor, `.reap-${Bun.randomUUIDv7()}`);
                const handle = await open(child, fileReadFlags);
                try {
                    const held = await handle.stat({ bigint: true });
                    if (!validFile(held, root.device) || held.ino !== metadata.ino)
                        fail();
                    await rename(child, retired);
                    await directory.handle.sync();
                    // Rename occurs inside the held directory; verify the renamed
                    // entry still identifies the descriptor-held inode.
                    const named = await lstat(retired, { bigint: true });
                    if (!validFile(named, root.device) || named.ino !== held.ino) fail();
                    await unlink(retired);
                } finally {
                    await handle.close();
                }
            } else if (validSocket(metadata, root.device)) {
                const retired = path.join(descriptor, `.reap-${Bun.randomUUIDv7()}`);
                await rename(child, retired);
                await directory.handle.sync();
                const named = await lstat(retired, { bigint: true });
                if (!validSocket(named, root.device) || named.ino !== metadata.ino) {
                    fail();
                }
                await unlink(retired);
            } else {
                fail();
            }
        }
        const remaining = await readdir(descriptor);
        if (remaining.length > 0) fail();
        await directory.handle.sync();
    } finally {
        await directory.handle.close();
    }
}

async function validateDirectory(
    root: OpenedDirectory,
    directoryPath: string,
    expectedInode: bigint,
    depth: number,
    observed: { count: number }
): Promise<void> {
    if (depth > maximumTreeDepth) fail();
    const directory = await openDirectory(directoryPath, {
        device: root.device,
        inode: expectedInode,
        mountId: root.mountId,
    });
    try {
        const descriptor = `/proc/self/fd/${directory.handle.fd}`;
        for (const entry of await readdir(descriptor, { withFileTypes: true })) {
            observed.count += 1;
            if (observed.count > maximumTreeEntries) fail();
            const child = path.join(descriptor, entry.name);
            const metadata = await lstat(child, { bigint: true });
            if (validDirectory(metadata, root.device)) {
                await validateDirectory(root, child, metadata.ino, depth + 1, observed);
            } else if (
                !validFile(metadata, root.device) &&
                !validSocket(metadata, root.device)
            ) {
                fail();
            }
        }
    } finally {
        await directory.handle.close();
    }
    const after = await lstat(directoryPath, { bigint: true });
    if (!validDirectory(after, root.device) || after.ino !== expectedInode) fail();
}

async function retireEmptyDirectory(
    root: OpenedDirectory,
    name: string,
    number: number
): Promise<void> {
    const descriptor = `/proc/self/fd/${root.handle.fd}`;
    const source = path.join(descriptor, name);
    let metadata: BigIntStats;
    try {
        metadata = await lstat(source, { bigint: true });
    } catch (error) {
        if (errorCode(error) === "ENOENT") return;
        return fail();
    }
    if (!validDirectory(metadata, root.device)) fail();
    const directory = await openDirectory(source, {
        device: root.device,
        inode: metadata.ino,
        mountId: root.mountId,
    });
    try {
        const entries = await readdir(`/proc/self/fd/${directory.handle.fd}`);
        if (entries.length > 0) fail();
    } finally {
        await directory.handle.close();
    }
    const retired = path.join(descriptor, `.retired-pr-${number}-${Bun.randomUUIDv7()}`);
    await rename(source, retired);
    await root.handle.sync();
    const named = await lstat(retired, { bigint: true });
    if (!validDirectory(named, root.device) || named.ino !== metadata.ino) fail();
    const retiredDirectory = await openDirectory(retired, {
        device: root.device,
        inode: metadata.ino,
        mountId: root.mountId,
    });
    try {
        const entries = await readdir(`/proc/self/fd/${retiredDirectory.handle.fd}`);
        if (entries.length > 0) fail();
    } finally {
        await retiredDirectory.handle.close();
    }
    await rmdir(retired);
    await root.handle.sync();
}

/** Descriptor/mount/inode-fenced deletion of one exact retained PR state tree. */
export async function removePreviewRetainedState(
    input: Readonly<{
        gatewaysRoot: string;
        ownersRoot: string;
        statesRoot: string;
    }>,
    owner: PreviewRetainedOwner
): Promise<void> {
    const parsed = v.parse(metadataSchema, owner);
    let gateways: OpenedDirectory | undefined;
    let owners: OpenedDirectory | undefined;
    let states: OpenedDirectory | undefined;
    try {
        gateways = await openDirectory(input.gatewaysRoot);
        owners = await openDirectory(input.ownersRoot);
        states = await openDirectory(input.statesRoot);
        const current = await readOwnerFromRoot(owners, parsed.number);
        if (
            current?.expectedHeadSha !== parsed.expectedHeadSha ||
            current.previewRevision !== parsed.previewRevision
        ) {
            fail();
        }
        const ownerFile = path.join(
            `/proc/self/fd/${owners.handle.fd}`,
            `pr-${parsed.number}.json`
        );
        const ownerMetadata = await lstat(ownerFile, { bigint: true });
        if (!validFile(ownerMetadata, owners.device)) fail();
        const source = path.join(
            `/proc/self/fd/${states.handle.fd}`,
            `pr-${parsed.number}`
        );
        let sourceMetadata: BigIntStats | undefined;
        try {
            sourceMetadata = await lstat(source, { bigint: true });
        } catch (error) {
            if (errorCode(error) !== "ENOENT") fail();
        }
        if (sourceMetadata !== undefined) {
            if (!validDirectory(sourceMetadata, states.device)) fail();
            await validateDirectory(states, source, sourceMetadata.ino, 0, {
                count: 0,
            });
            const retired = path.join(
                `/proc/self/fd/${states.handle.fd}`,
                `.retired-pr-${parsed.number}-${Bun.randomUUIDv7()}`
            );
            await rename(source, retired);
            await states.handle.sync();
            const named = await lstat(retired, { bigint: true });
            if (
                !validDirectory(named, states.device) ||
                named.ino !== sourceMetadata.ino
            ) {
                fail();
            }
            await emptyDirectory(states, retired, sourceMetadata.ino, 0, { count: 0 });
            const after = await lstat(retired, { bigint: true });
            if (!validDirectory(after, states.device) || after.ino !== named.ino) fail();
            await rmdir(retired);
            await states.handle.sync();
        }
        await retireEmptyDirectory(gateways, `pr-${parsed.number}`, parsed.number);
        await retireAndUnlinkFile(owners, `pr-${parsed.number}.json`, ownerMetadata.ino);
    } finally {
        await states?.handle.close().catch(() => {});
        await owners?.handle.close().catch(() => {});
        await gateways?.handle.close().catch(() => {});
    }
}

/**
 * Reaps only crash-left state tombstones after the same bounded full validation.
 * @param statesRoot Private retained state root.
 * @returns Number of exact validated tombstones removed.
 */
export async function reapPreviewRetainedStages(statesRoot: string): Promise<number> {
    const root = await openDirectory(statesRoot);
    let removed = 0;
    try {
        const entries = await readdir(`/proc/self/fd/${root.handle.fd}`, {
            withFileTypes: true,
        });
        if (entries.length > maximumRootEntries) fail();
        for (const entry of entries) {
            if (!retiredStatePattern.test(entry.name)) continue;
            const candidate = path.join(`/proc/self/fd/${root.handle.fd}`, entry.name);
            const metadata = await lstat(candidate, { bigint: true });
            if (!entry.isDirectory() || !validDirectory(metadata, root.device)) fail();
            await validateDirectory(root, candidate, metadata.ino, 0, { count: 0 });
            await emptyDirectory(root, candidate, metadata.ino, 0, { count: 0 });
            const after = await lstat(candidate, { bigint: true });
            if (!validDirectory(after, root.device) || after.ino !== metadata.ino) fail();
            await rmdir(candidate);
            removed += 1;
        }
        if (removed > 0) await root.handle.sync();
        return removed;
    } finally {
        await root.handle.close();
    }
}

/**
 * Reaps only descriptor-verified owner stages left before their atomic rename.
 * @param ownersRoot Private host-only owner root.
 * @returns Number of exact validated stages removed.
 */
export async function reapPreviewRetainedOwnerStages(
    ownersRoot: string
): Promise<number> {
    const root = await openDirectory(ownersRoot);
    let removed = 0;
    try {
        const entries = await readdir(`/proc/self/fd/${root.handle.fd}`, {
            withFileTypes: true,
        });
        if (entries.length > maximumRootEntries) fail();
        for (const entry of entries) {
            if (
                !stagedOwnerPattern.test(entry.name) &&
                !stagedReconciliationGatePattern.test(entry.name)
            ) {
                continue;
            }
            const candidate = path.join(`/proc/self/fd/${root.handle.fd}`, entry.name);
            const handle = await open(candidate, fileReadFlags).catch(() => fail());
            try {
                const held = await handle.stat({ bigint: true });
                const named = await lstat(candidate, { bigint: true });
                if (
                    !entry.isFile() ||
                    !validFile(held, root.device) ||
                    !validFile(named, root.device) ||
                    held.ino !== named.ino
                ) {
                    fail();
                }
                await unlink(candidate);
                await root.handle.sync();
                removed += 1;
            } finally {
                await handle.close();
            }
        }
        return removed;
    } finally {
        await root.handle.close();
    }
}
