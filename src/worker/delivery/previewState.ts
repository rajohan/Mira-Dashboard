import { constants, type Dirent, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import {
    PreviewHostError,
    previewDurableRecordSchema,
    previewFormatVersion,
    previewStateMaximumBytes,
    type PreviewDurableRecord,
} from "./previewTypes.ts";

const stateFileName = "active-preview.json";
const developmentStateMarkerFileName = ".mira-dashboard-development-state.json";
const developmentStateMarker = Object.freeze({
    formatVersion: 1,
    owner: "mira-dashboard-source-development-v1",
});
const staleStatePattern =
    /^(?:\.active-preview\.[0-9a-f-]{36}\.tmp|\.retired-active-preview-[0-9a-f-]{36})$/u;
const directoryOpenFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileReadFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const fileCreateFlags =
    constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | constants.O_RDWR;

export interface PreviewStatePaths {
    readonly gatewaysRoot: string;
    readonly ingressRoot: string;
    readonly root: string;
    readonly ownersRoot: string;
    readonly stateFile: string;
    readonly statesRoot: string;
    readonly worktreesRoot: string;
}

function fail(reason: PreviewHostError["reason"]): never {
    throw new PreviewHostError({ reason });
}

function isStrictlyContained(root: string, candidate: string): boolean {
    const relative = path.relative(root, candidate);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function validateAbsoluteNonRoot(candidate: string): string {
    const normalized = path.normalize(candidate);
    if (
        !path.isAbsolute(candidate) ||
        normalized !== candidate ||
        candidate === path.parse(candidate).root ||
        candidate.includes("\0")
    ) {
        fail("path-unsafe");
    }
    return candidate;
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
    try {
        await mkdir(directory, { mode: 0o700, recursive: true });
    } catch {
        fail("path-unsafe");
    }
    let handle;
    try {
        handle = await open(directory, directoryOpenFlags);
        const [held, named, canonical] = await Promise.all([
            handle.stat({ bigint: true }),
            lstat(directory, { bigint: true }),
            realpath(`/proc/self/fd/${String(handle.fd)}`),
        ]);
        if (
            typeof process.getuid !== "function" ||
            !held.isDirectory() ||
            held.isSymbolicLink() ||
            !named.isDirectory() ||
            named.isSymbolicLink() ||
            held.uid !== BigInt(process.getuid()) ||
            named.uid !== held.uid ||
            held.dev !== named.dev ||
            held.ino !== named.ino ||
            canonical !== directory
        ) {
            fail("path-unsafe");
        }
        await handle.chmod(0o700);
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        fail("path-unsafe");
    } finally {
        await handle?.close();
    }
}

async function openRoot(root: string) {
    await ensurePrivateDirectory(root);
    const handle = await open(root, directoryOpenFlags);
    const metadata = await handle.stat({ bigint: true });
    const canonical = await realpath(`/proc/self/fd/${String(handle.fd)}`);
    if (!metadata.isDirectory() || canonical !== root) {
        await handle.close();
        fail("path-unsafe");
    }
    return handle;
}

function isPrivateRegularFile(metadata: Stats | import("node:fs").BigIntStats): boolean {
    return (
        metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.nlink === (typeof metadata.nlink === "bigint" ? 1n : 1) &&
        (Number(metadata.mode) & 0o777) === 0o600
    );
}

async function readBoundedState(rootHandle: Awaited<ReturnType<typeof openRoot>>) {
    let handle;
    try {
        handle = await open(
            path.join(`/proc/self/fd/${String(rootHandle.fd)}`, stateFileName),
            fileReadFlags
        );
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        fail("state-unavailable");
    }
    try {
        const before = await handle.stat({ bigint: true });
        if (
            !isPrivateRegularFile(before) ||
            before.size <= 0n ||
            before.size > BigInt(previewStateMaximumBytes)
        ) {
            fail("state-unavailable");
        }
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const { bytesRead } = await handle.read(
                bytes,
                offset,
                bytes.length - offset,
                offset
            );
            if (bytesRead === 0) break;
            offset += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        if (
            offset !== bytes.length ||
            before.dev !== after.dev ||
            before.ino !== after.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs
        ) {
            fail("state-conflict");
        }
        const decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        return v.parse(previewDurableRecordSchema, JSON.parse(decoded) as unknown);
    } catch (error) {
        if (error instanceof PreviewHostError) throw error;
        fail("state-unavailable");
    } finally {
        await handle.close();
    }
}

/**
 * Resolves one fixed preview root without following an existing symlink.
 * @param rootInput Absolute process-owned preview root.
 * @returns Canonical private paths for active and retained state.
 */
export async function resolvePreviewStatePaths(
    rootInput: string
): Promise<PreviewStatePaths> {
    const root = validateAbsoluteNonRoot(path.resolve(rootInput));
    const parent = await realpath(path.dirname(root));
    if (path.dirname(root) !== parent) fail("path-unsafe");
    await ensurePrivateDirectory(root);
    if ((await realpath(root)) !== root) fail("path-unsafe");
    const ownersRoot = path.join(root, "owners");
    const gatewaysRoot = path.join(root, "gateways");
    const ingressRoot = path.join(root, "ingress");
    const statesRoot = path.join(root, "states");
    const worktreesRoot = path.join(root, "worktrees");
    await ensurePrivateDirectory(gatewaysRoot);
    await ensurePrivateDirectory(ingressRoot);
    await ensurePrivateDirectory(ownersRoot);
    await ensurePrivateDirectory(statesRoot);
    await ensurePrivateDirectory(worktreesRoot);
    return Object.freeze({
        gatewaysRoot,
        ingressRoot,
        root,
        ownersRoot,
        stateFile: path.join(root, stateFileName),
        statesRoot,
        worktreesRoot,
    });
}

/**
 * Resolves one host-owned per-PR Gateway root that candidate code sees read-only.
 * @param paths Canonical preview state paths.
 * @param number Exact pull-request number.
 * @returns Canonical private Gateway root.
 */
export async function ensurePreviewPrGatewayRoot(
    paths: PreviewStatePaths,
    number: number
): Promise<string> {
    if (!Number.isSafeInteger(number) || number <= 0) fail("invalid-request");
    await ensurePrivateDirectory(paths.gatewaysRoot);
    const gatewayRoot = path.join(paths.gatewaysRoot, `pr-${number}`);
    if (!isStrictlyContained(paths.gatewaysRoot, gatewayRoot)) fail("path-unsafe");
    await ensurePrivateDirectory(gatewayRoot);
    const [canonicalGateways, canonicalGateway] = await Promise.all([
        realpath(paths.gatewaysRoot),
        realpath(gatewayRoot),
    ]);
    if (
        canonicalGateways !== paths.gatewaysRoot ||
        canonicalGateway !== gatewayRoot ||
        !isStrictlyContained(canonicalGateways, canonicalGateway)
    ) {
        fail("path-unsafe");
    }
    return gatewayRoot;
}

/**
 * Resolves one exact per-PR managed checkout without consulting candidate state.
 * @param paths Canonical preview state paths.
 * @param number Exact pull-request number.
 * @returns Deterministic per-PR worktree path.
 */
export function previewWorktreePath(paths: PreviewStatePaths, number: number): string {
    if (!Number.isSafeInteger(number) || number <= 0) fail("invalid-request");
    const candidate = path.join(paths.worktreesRoot, `pr-${number}`);
    if (!isStrictlyContained(paths.worktreesRoot, candidate)) fail("path-unsafe");
    return candidate;
}

export async function readPreviewState(
    paths: PreviewStatePaths
): Promise<PreviewDurableRecord | undefined> {
    const root = await openRoot(paths.root);
    try {
        return await readBoundedState(root);
    } finally {
        await root.close();
    }
}

export async function writePreviewState(
    paths: PreviewStatePaths,
    record: PreviewDurableRecord,
    expectedRevision?: string
): Promise<void> {
    let parsed: PreviewDurableRecord;
    try {
        parsed = v.parse(previewDurableRecordSchema, record);
    } catch {
        fail("invalid-request");
    }
    const root = await openRoot(paths.root);
    const descriptorRoot = `/proc/self/fd/${String(root.fd)}`;
    const temporaryName = `.active-preview.${Bun.randomUUIDv7()}.tmp`;
    const temporaryPath = path.join(descriptorRoot, temporaryName);
    try {
        const current = await readBoundedState(root);
        if (
            expectedRevision !== undefined &&
            current?.previewRevision !== expectedRevision
        ) {
            fail("state-conflict");
        }
        if (expectedRevision === undefined && current !== undefined) {
            fail("state-conflict");
        }
        const bytes = Buffer.from(`${JSON.stringify(parsed)}\n`, "utf8");
        if (bytes.length > previewStateMaximumBytes) fail("invalid-request");
        const file = await open(temporaryPath, fileCreateFlags, 0o600);
        try {
            await file.chmod(0o600);
            await file.writeFile(bytes);
            await file.sync();
            const metadata = await file.stat({ bigint: true });
            if (
                !isPrivateRegularFile(metadata) ||
                metadata.size !== BigInt(bytes.length)
            ) {
                fail("state-unavailable");
            }
        } finally {
            await file.close();
        }
        await rename(temporaryPath, path.join(descriptorRoot, stateFileName));
        await root.sync();
    } finally {
        await rm(temporaryPath, { force: true }).catch(() => {});
        await root.close();
    }
}

/**
 * Removes only crash-left private staging files, never the durable slot record.
 * @param paths Canonical preview state paths.
 * @returns Number of exact private stages removed.
 */
export async function reapPreviewStateStages(paths: PreviewStatePaths): Promise<number> {
    const root = await openRoot(paths.root);
    const descriptorRoot = `/proc/self/fd/${String(root.fd)}`;
    let removed = 0;
    try {
        const entries: Dirent[] = await readdir(descriptorRoot, { withFileTypes: true });
        for (const entry of entries) {
            if (!staleStatePattern.test(entry.name) || !entry.isFile()) continue;
            const candidate = path.join(descriptorRoot, entry.name);
            const metadata = await lstat(candidate, { bigint: true });
            if (!isPrivateRegularFile(metadata)) fail("path-unsafe");
            await rm(candidate);
            removed += 1;
        }
        if (removed > 0) await root.sync();
        return removed;
    } finally {
        await root.close();
    }
}

export async function ensurePreviewPrStateRoot(
    paths: PreviewStatePaths,
    number: number
): Promise<string> {
    if (!Number.isSafeInteger(number) || number <= 0) fail("invalid-request");
    await ensurePrivateDirectory(paths.statesRoot);
    const stateRoot = path.join(paths.statesRoot, `pr-${number}`);
    if (!isStrictlyContained(paths.statesRoot, stateRoot)) fail("path-unsafe");
    await ensurePrivateDirectory(stateRoot);
    const canonicalStates = await realpath(paths.statesRoot);
    const canonicalState = await realpath(stateRoot);
    if (
        canonicalStates !== paths.statesRoot ||
        canonicalState !== stateRoot ||
        !isStrictlyContained(canonicalStates, canonicalState)
    ) {
        fail("path-unsafe");
    }
    return stateRoot;
}

/**
 * Claims only the private preview state envelope for the managed candidate runtime.
 * Candidate code may initialize its own SQLite schema inside the mounted directory,
 * but cannot select or import any host state source.
 * @param paths Canonical preview state paths.
 * @param number Exact pull-request number.
 * @returns Exact private candidate-writable state root.
 */
export async function prepareManagedPreviewStateRoot(
    paths: PreviewStatePaths,
    number: number
): Promise<string> {
    const stateRoot = await ensurePreviewPrStateRoot(paths, number);
    const markerPath = path.join(stateRoot, developmentStateMarkerFileName);
    const expected = `${JSON.stringify(developmentStateMarker, null, 2)}\n`;
    let handle;
    try {
        handle = await open(markerPath, fileCreateFlags, 0o600);
        await handle.chmod(0o600);
        await handle.writeFile(expected, "utf8");
        await handle.sync();
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
            fail("state-unavailable");
        }
        try {
            // O_NOFOLLOW opens the object itself; all validation and reads below
            // use this same held descriptor rather than the checked pathname.
            handle = await open(markerPath, fileReadFlags);
            const metadata = await handle.stat({ bigint: true });
            if (
                !isPrivateRegularFile(metadata) ||
                metadata.size !== BigInt(Buffer.byteLength(expected)) ||
                (await handle.readFile("utf8")) !== expected
            ) {
                fail("state-unavailable");
            }
        } catch (readError) {
            if (readError instanceof PreviewHostError) throw readError;
            fail("state-unavailable");
        }
    } finally {
        await handle?.close();
    }
    return stateRoot;
}

export async function removePreviewStateFile(paths: PreviewStatePaths): Promise<void> {
    const root = await openRoot(paths.root);
    const descriptor = `/proc/self/fd/${String(root.fd)}`;
    const source = path.join(descriptor, stateFileName);
    const retired = path.join(
        descriptor,
        `.retired-active-preview-${Bun.randomUUIDv7()}`
    );
    let handle;
    try {
        try {
            handle = await open(source, fileReadFlags);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            fail("state-unavailable");
        }
        const held = await handle.stat({ bigint: true });
        const named = await lstat(source, { bigint: true });
        if (
            !isPrivateRegularFile(held) ||
            !isPrivateRegularFile(named) ||
            held.dev !== named.dev ||
            held.ino !== named.ino
        ) {
            fail("state-unavailable");
        }
        await rename(source, retired);
        await root.sync();
        const retiredNamed = await lstat(retired, { bigint: true });
        if (
            !isPrivateRegularFile(retiredNamed) ||
            retiredNamed.dev !== held.dev ||
            retiredNamed.ino !== held.ino
        ) {
            fail("state-unavailable");
        }
        await rm(retired);
        await root.sync();
    } finally {
        await handle?.close();
        await root.close();
    }
}

export function createInitialStoppedRecord(input: {
    expectedHeads: PreviewDurableRecord["expectedHeads"];
    nowMs: number;
    number: number;
    operationId: string;
    previewRevision: string;
    publicOrigin: string;
    title: string;
}): PreviewDurableRecord {
    return v.parse(previewDurableRecordSchema, {
        expectedHeads: input.expectedHeads,
        expiresAtMs: input.nowMs,
        formatVersion: previewFormatVersion,
        number: input.number,
        operationId: input.operationId,
        ownsTailscaleServe: false,
        previewRevision: input.previewRevision,
        publicOrigin: input.publicOrigin,
        status: "stopped",
        title: input.title,
        updatedAtMs: input.nowMs,
    });
}
