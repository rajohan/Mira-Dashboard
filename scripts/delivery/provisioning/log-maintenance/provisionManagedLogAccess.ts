import { constants, type BigIntStats } from "node:fs";
import {
    mkdtemp,
    mkdir,
    open,
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
const groupIdPattern = /^(?:0|[1-9]\d{0,9})$/u;

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
        if (
            !status.isDirectory() ||
            Number(status.uid) !== specification.ownerId ||
            Number(status.gid) !== specification.groupId
        ) {
            throw failure();
        }
        await directory.chmod(specification.mode);
        const verified = await canonicalStatus(directory, specification.directoryPath);
        if ((verified.mode & 0o7777n) !== BigInt(specification.mode)) throw failure();
        return directory;
    } catch (error) {
        await close(directory);
        throw error;
    }
}

async function provisionDirectoryChain(
    anchorSpecification: ManagedLogProvisioningAnchor,
    directories: readonly ManagedLogProvisionedDirectory[],
    applyDefaultAccess: (directoryPath: string, groupId: number) => Promise<void>
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
    groupId: number
): Promise<void> {
    if (/\s/u.test(directoryPath)) throw failure();
    const temporaryRoot = await mkdtemp("/run/mira-dashboard-log-access-");
    const configurationPath = path.join(temporaryRoot, "access.conf");
    try {
        await writeFile(
            configurationPath,
            `a+ ${directoryPath} - - - - d:group:${groupId}:rwx,d:mask::rwx\n`,
            { flag: "wx", mode: 0o600 }
        );
        const child = Bun.spawn(
            ["/usr/bin/systemd-tmpfiles", "--create", configurationPath],
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
    applyDefaultAccess: (directoryPath: string, groupId: number) => Promise<void>
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
                applyDefaultAccess
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
        }

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
        readonly applyDefaultAccess?: (
            directoryPath: string,
            groupId: number
        ) => Promise<void>;
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
        const applyDefaultAccess = options.applyDefaultAccess ?? applyDefaultGroupAccess;
        for (const target of targets) {
            await provisionTarget(target, groupId, applyDefaultAccess);
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
