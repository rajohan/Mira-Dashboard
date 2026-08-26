import { randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
    mkdtemp,
    mkdir,
    open,
    opendir,
    realpath,
    rm,
    writeFile,
    type FileHandle,
} from "node:fs/promises";
import path from "node:path";

import {
    createManagedLogManifest,
    type ManagedLogProvisionedDirectory,
    type ManagedLogProvisioningAnchor,
    type ManagedLogFileTarget,
    type ManagedLogManifest,
    validateManagedLogManifest,
} from "../../../../src/shared/managedLogManifest.ts";

const failureMessage = "Managed log access provisioning failed";
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const accessProbeFlags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
const groupIdPattern = /^(?:0|[1-9]\d{0,9})$/u;
const archiveEntryMaximum = 4096;

function failure(): Error {
    return new Error(failureMessage);
}

function errorCode(error: unknown): string | undefined {
    return error instanceof Error && "code" in error
        ? (error as NodeJS.ErrnoException).code
        : undefined;
}

async function close(handle: FileHandle | undefined): Promise<void> {
    await handle?.close().catch(() => {});
}

function trustedTargetOwner(target: ManagedLogFileTarget, status: BigIntStats): boolean {
    return target.trustedOwnerIds.includes(Number(status.uid));
}

function descriptorPath(handle: FileHandle): string {
    return `/proc/${process.pid}/fd/${handle.fd}`;
}

function escapeRegularExpression(value: string): string {
    return value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`);
}

function rotatedArchivePattern(fileName: string): RegExp {
    return new RegExp(
        `^${escapeRegularExpression(fileName)}\\.\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}\\.\\d{3}Z\\.[0-9a-f-]{36}(?:\\.gz)?$`,
        "u"
    );
}

async function provisionExistingArchives(
    directory: FileHandle,
    directoryStatus: BigIntStats,
    target: ManagedLogFileTarget,
    groupId: number,
    beforeArchiveOpen?: (fileName: string) => Promise<void> | void
): Promise<void> {
    const sourceName = path.basename(target.filePath);
    const archivePattern = rotatedArchivePattern(sourceName);
    const stream = await opendir(descriptorPath(directory));
    let checkedEntries = 0;
    try {
        for await (const entry of stream) {
            checkedEntries += 1;
            if (checkedEntries > archiveEntryMaximum) throw failure();
            if (!archivePattern.test(entry.name)) continue;
            await beforeArchiveOpen?.(entry.name);
            const archivePath = path.join(descriptorPath(directory), entry.name);
            let archive: FileHandle | undefined;
            try {
                try {
                    archive = await open(archivePath, fileFlags);
                } catch (error) {
                    if (errorCode(error) === "ENOENT") continue;
                    throw error;
                }
                const archiveStatus = await canonicalStatus(
                    archive,
                    path.join(path.dirname(target.filePath), entry.name)
                );
                if (
                    !archiveStatus.isFile() ||
                    archiveStatus.nlink !== 1n ||
                    archiveStatus.dev !== directoryStatus.dev ||
                    archiveStatus.size >
                        BigInt(target.maximumSourceBytes + 1024 * 1024) ||
                    !trustedTargetOwner(target, archiveStatus)
                ) {
                    throw failure();
                }
                await archive.chown(Number(archiveStatus.uid), groupId);
                await archive.chmod(0o640);
                const verified = await canonicalStatus(
                    archive,
                    path.join(path.dirname(target.filePath), entry.name)
                );
                if (
                    verified.uid !== archiveStatus.uid ||
                    verified.gid !== BigInt(groupId) ||
                    (verified.mode & 0o7777n) !== 0o640n
                ) {
                    throw failure();
                }
            } finally {
                await close(archive);
            }
        }
    } finally {
        await stream.close().catch(() => {});
    }
}

async function verifyDefaultGroupAccess(
    directory: FileHandle,
    groupId: number
): Promise<void> {
    const probePath = path.join(
        descriptorPath(directory),
        `.mira-dashboard-access-probe-${randomUUID()}`
    );
    let probe: FileHandle | undefined;
    try {
        probe = await open(probePath, accessProbeFlags, 0o666);
        const status = await probe.stat({ bigint: true });
        if (
            !status.isFile() ||
            status.nlink !== 1n ||
            status.gid !== BigInt(groupId) ||
            (status.mode & 0o060n) !== 0o060n
        ) {
            throw failure();
        }
    } finally {
        await close(probe);
        await rm(probePath, { force: true }).catch(() => {});
    }
}

async function openProvisionedDirectory(
    parent: FileHandle,
    specification: ManagedLogProvisionedDirectory
): Promise<FileHandle> {
    const anchoredPath = path.join(
        `/proc/self/fd/${parent.fd}`,
        path.basename(specification.directoryPath)
    );
    let created = false;
    try {
        await mkdir(anchoredPath, { mode: 0o700 });
        created = true;
    } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
    }
    const directory = await open(anchoredPath, directoryFlags);
    try {
        if (created) {
            await directory.chown(specification.ownerId, specification.groupId);
        }
        const status = await canonicalStatus(directory, specification.directoryPath);
        if (!status.isDirectory() || Number(status.uid) !== specification.ownerId) {
            throw failure();
        }
        await directory.chown(specification.ownerId, specification.groupId);
        await directory.chmod(specification.mode);
        const verified = await canonicalStatus(directory, specification.directoryPath);
        if (
            verified.uid !== BigInt(specification.ownerId) ||
            verified.gid !== BigInt(specification.groupId) ||
            (verified.mode & 0o7777n) !== BigInt(specification.mode)
        ) {
            throw failure();
        }
        return directory;
    } catch (error) {
        await close(directory);
        throw error;
    }
}

async function provisionDirectoryChain(
    anchorSpecification: ManagedLogProvisioningAnchor,
    directories: readonly ManagedLogProvisionedDirectory[],
    applyDefaultAccess: (directoryPath: string, groupId: number) => Promise<void>,
    verifyDefaultAccess: (directory: FileHandle, groupId: number) => Promise<void>
): Promise<FileHandle> {
    let parent = await open(anchorSpecification.directoryPath, directoryFlags);
    try {
        const anchor = await canonicalStatus(parent, anchorSpecification.directoryPath);
        if (
            !anchor.isDirectory() ||
            Number(anchor.uid) !== anchorSpecification.ownerId ||
            Number(anchor.gid) !== anchorSpecification.groupId ||
            (anchor.mode & 0o7777n) !== BigInt(anchorSpecification.mode)
        ) {
            throw failure();
        }
        for (const specification of directories) {
            const directory = await openProvisionedDirectory(parent, specification);
            await close(parent);
            parent = directory;
            if (specification.inheritGroupAccess) {
                await applyDefaultAccess(
                    descriptorPath(directory),
                    specification.groupId
                );
                await verifyDefaultAccess(directory, specification.groupId);
            }
        }
        return parent;
    } catch (error) {
        await close(parent);
        throw error;
    }
}

async function canonicalStatus(
    handle: FileHandle,
    expectedPath: string
): Promise<BigIntStats> {
    const [status, canonical] = await Promise.all([
        handle.stat({ bigint: true }),
        realpath(`/proc/self/fd/${handle.fd}`),
    ]);
    if (canonical !== expectedPath || status.isSymbolicLink()) throw failure();
    return status;
}

async function applyDefaultGroupAccess(
    directoryPath: string,
    groupId: number,
    temporaryRootPrefix = "/run/mira-dashboard-log-access-"
): Promise<void> {
    if (/\s/u.test(directoryPath)) throw failure();
    const temporaryRoot = await mkdtemp(temporaryRootPrefix);
    const configurationPath = path.join(temporaryRoot, "access.conf");
    try {
        await writeFile(
            configurationPath,
            `a+ / - - - - d:group:${groupId}:rwx,d:mask::rwx\n`,
            { flag: "wx", mode: 0o600 }
        );
        const child = Bun.spawn(
            [
                "/usr/bin/systemd-tmpfiles",
                `--root=${directoryPath}`,
                "--create",
                configurationPath,
            ],
            { stderr: "ignore", stdin: "ignore", stdout: "ignore" }
        );
        if ((await child.exited) !== 0) throw failure();
    } finally {
        await rm(temporaryRoot, { force: true, recursive: true }).catch(() => {});
    }
}

async function provisionTarget(
    target: ManagedLogFileTarget,
    groupId: number,
    applyDefaultAccess: (directoryPath: string, groupId: number) => Promise<void>,
    verifyDefaultAccess: (directory: FileHandle, groupId: number) => Promise<void>,
    beforeArchiveOpen?: (fileName: string) => Promise<void> | void
): Promise<void> {
    const directoryPath = path.dirname(target.filePath);
    let directory: FileHandle | undefined;
    let file: FileHandle | undefined;
    try {
        if (target.provisionedDirectories === undefined) {
            try {
                directory = await open(directoryPath, directoryFlags);
            } catch (error) {
                if (errorCode(error) !== "ENOENT") throw error;
            }
        } else {
            if (target.provisioningAnchor === undefined) throw failure();
            directory = await provisionDirectoryChain(
                target.provisioningAnchor,
                target.provisionedDirectories,
                applyDefaultAccess,
                verifyDefaultAccess
            );
        }
        if (directory === undefined) return;
        const directoryStatus = await canonicalStatus(directory, directoryPath);
        if (
            !directoryStatus.isDirectory() ||
            !trustedTargetOwner(target, directoryStatus)
        ) {
            throw failure();
        }
        await directory.chown(Number(directoryStatus.uid), groupId);
        await directory.chmod(0o2770);
        if (target.provisionedDirectories === undefined) {
            await applyDefaultAccess(descriptorPath(directory), groupId);
            await verifyDefaultAccess(directory, groupId);
        }
        await provisionExistingArchives(
            directory,
            directoryStatus,
            target,
            groupId,
            beforeArchiveOpen
        );

        try {
            file = await open(
                path.join(descriptorPath(directory), path.basename(target.filePath)),
                fileFlags
            );
        } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw error;
        }
        const fileStatus = await canonicalStatus(file, target.filePath);
        if (
            !fileStatus.isFile() ||
            fileStatus.nlink !== 1n ||
            fileStatus.dev !== directoryStatus.dev ||
            !trustedTargetOwner(target, fileStatus)
        ) {
            throw failure();
        }
        await file.chown(Number(fileStatus.uid), groupId);
        await file.chmod(0o660);

        const [verifiedDirectory, verifiedFile] = await Promise.all([
            canonicalStatus(directory, directoryPath),
            canonicalStatus(file, target.filePath),
        ]);
        if (
            verifiedDirectory.uid !== directoryStatus.uid ||
            verifiedDirectory.gid !== BigInt(groupId) ||
            (verifiedDirectory.mode & 0o7777n) !== 0o2770n ||
            verifiedFile.uid !== fileStatus.uid ||
            verifiedFile.gid !== BigInt(groupId) ||
            (verifiedFile.mode & 0o7777n) !== 0o660n
        ) {
            throw failure();
        }
    } finally {
        await close(file);
        await close(directory);
    }
}

/**
 * Grants bounded rotation access to every manifest target that opts into a shared group.
 * @param groupId - The already-admitted maintenance group identifier.
 * @param runtimeUserId - The already-admitted runtime account identifier.
 * @param options - Test-only manifest and root-identity substitutions.
 */
export async function provisionManagedLogAccess(
    groupId: number,
    runtimeUserId: number,
    options: {
        readonly manifest?: ManagedLogManifest;
        readonly requireRoot?: () => boolean;
        readonly temporaryAccessRootPrefix?: string;
        readonly applyDefaultAccess?: (
            directoryPath: string,
            groupId: number
        ) => Promise<void>;
        readonly verifyDefaultAccess?: (
            directory: FileHandle,
            groupId: number
        ) => Promise<void>;
        readonly beforeArchiveOpen?: (fileName: string) => Promise<void> | void;
    } = {}
): Promise<void> {
    if (
        !(options.requireRoot?.() ?? process.getuid?.() === 0) ||
        !Number.isSafeInteger(groupId) ||
        groupId < 1 ||
        !Number.isSafeInteger(runtimeUserId) ||
        runtimeUserId < 1
    ) {
        throw failure();
    }
    const manifest = options.manifest ?? createManagedLogManifest(runtimeUserId, groupId);
    try {
        validateManagedLogManifest(manifest);
        const targets = manifest.fileTargets.filter(
            (target) => target.trustedWritableGroupId === groupId
        );
        const applyDefaultAccess =
            options.applyDefaultAccess ??
            ((directoryPath, selectedGroupId) =>
                applyDefaultGroupAccess(
                    directoryPath,
                    selectedGroupId,
                    options.temporaryAccessRootPrefix
                ));
        const verifyDefaultAccess =
            options.verifyDefaultAccess ?? verifyDefaultGroupAccess;
        for (const target of targets) {
            await provisionTarget(
                target,
                groupId,
                applyDefaultAccess,
                verifyDefaultAccess,
                options.beforeArchiveOpen
            );
        }
    } catch {
        throw failure();
    }
}

if (import.meta.main) {
    const groupArgument = process.argv[2] ?? "";
    const userArgument = process.argv[3] ?? "";
    if (
        process.argv.length !== 4 ||
        !groupArgument.startsWith("--group-id=") ||
        !userArgument.startsWith("--runtime-user-id=")
    ) {
        throw failure();
    }
    const groupValue = groupArgument.slice("--group-id=".length);
    const userValue = userArgument.slice("--runtime-user-id=".length);
    if (
        !groupIdPattern.test(groupValue) ||
        Number(groupValue) === 0 ||
        !groupIdPattern.test(userValue) ||
        Number(userValue) === 0
    ) {
        throw failure();
    }
    await provisionManagedLogAccess(Number(groupValue), Number(userValue));
    process.stdout.write("Managed log access provisioned.\n");
}
