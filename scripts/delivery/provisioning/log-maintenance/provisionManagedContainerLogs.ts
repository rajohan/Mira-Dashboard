import { constants, type Stats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

const failureMessage = "Managed container log provisioning failed";
const directoryFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const createFileFlags = fileFlags | constants.O_CREAT | constants.O_EXCL;
const groupIdPattern = /^(?:0|[1-9]\d{0,9})$/u;

interface ManagedContainerLogTarget {
    readonly directoryPath: string;
    readonly fileNames: readonly string[];
    readonly ownerIds: readonly number[];
}

const targets: readonly ManagedContainerLogTarget[] = Object.freeze([
    Object.freeze({
        directoryPath: "/opt/docker/data/prowlarr/logs",
        fileNames: Object.freeze([
            "prowlarr.debug.txt",
            "prowlarr.trace.txt",
            "prowlarr.txt",
        ]),
        ownerIds: Object.freeze([0, 1001]),
    }),
    Object.freeze({
        directoryPath: "/opt/docker/data/submaker/logs",
        fileNames: Object.freeze(["app.log"]),
        ownerIds: Object.freeze([0, 1000]),
    }),
    Object.freeze({
        directoryPath: "/opt/docker/data/traefik",
        fileNames: Object.freeze(["access.log"]),
        ownerIds: Object.freeze([0, 1001]),
    }),
]);

function failure(): Error {
    return new Error(failureMessage);
}

async function close(handle: FileHandle | undefined): Promise<void> {
    await handle?.close().catch(() => {});
}

function trustedDirectory(status: Stats, ownerIds: readonly number[]): boolean {
    return (
        status.isDirectory() && !status.isSymbolicLink() && ownerIds.includes(status.uid)
    );
}

function trustedFile(status: Stats, ownerIds: readonly number[]): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1 &&
        ownerIds.includes(status.uid) &&
        (status.mode & 0o002) === 0
    );
}

interface OpenedManagedLogFile {
    readonly handle: FileHandle;
    readonly ownerId: number;
    readonly status: Stats;
}

interface OpenedManagedLogTarget {
    readonly directory: FileHandle;
    readonly directoryStatus: Stats;
    readonly files: readonly OpenedManagedLogFile[];
    readonly missingFileNames: readonly string[];
}

async function closeTarget(target: OpenedManagedLogTarget): Promise<void> {
    await Promise.all(target.files.map(({ handle }) => close(handle)));
    await close(target.directory);
}

async function openTarget(
    target: ManagedContainerLogTarget
): Promise<OpenedManagedLogTarget | undefined> {
    let directory: FileHandle | undefined;
    const files: OpenedManagedLogFile[] = [];
    try {
        try {
            directory = await open(target.directoryPath, directoryFlags);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw error;
        }
        const [status, canonical] = await Promise.all([
            directory.stat(),
            realpath(`/proc/self/fd/${directory.fd}`),
        ]);
        const missingFileNames: string[] = [];
        if (
            canonical !== target.directoryPath ||
            !trustedDirectory(status, target.ownerIds)
        ) {
            throw failure();
        }
        for (const fileName of target.fileNames) {
            let file: FileHandle | undefined;
            try {
                file = await open(
                    path.join(`/proc/self/fd/${directory.fd}`, fileName),
                    fileFlags
                );
                const fileStatus = await file.stat();
                if (!trustedFile(fileStatus, target.ownerIds)) throw failure();
                files.push(
                    Object.freeze({
                        handle: file,
                        ownerId: fileStatus.uid,
                        status: fileStatus,
                    })
                );
                file = undefined;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                missingFileNames.push(fileName);
            } finally {
                await close(file);
            }
        }
        const opened = Object.freeze({
            directory,
            directoryStatus: status,
            files,
            missingFileNames: Object.freeze(missingFileNames),
        });
        directory = undefined;
        return opened;
    } catch {
        await Promise.all(files.map(({ handle }) => close(handle)));
        throw failure();
    } finally {
        await close(directory);
    }
}

async function openOrCreateMissingFile(
    target: OpenedManagedLogTarget,
    fileName: string
): Promise<OpenedManagedLogFile> {
    const filePath = path.join(`/proc/self/fd/${target.directory.fd}`, fileName);
    const handle = await open(filePath, createFileFlags, 0o600);
    try {
        const status = await handle.stat();
        if (!trustedFile(status, [0, target.directoryStatus.uid])) throw failure();
        return Object.freeze({
            handle,
            ownerId: target.directoryStatus.uid,
            status,
        });
    } catch {
        await close(handle);
        throw failure();
    }
}

/**
 * Provisions fixed container log directories for the dedicated maintenance group.
 * @param groupId Existing root-created maintenance group id.
 * @param options Test-only fixed identity and target seams.
 */
export async function provisionManagedContainerLogs(
    groupId: number,
    options: {
        readonly requireRoot?: () => boolean;
        readonly targets?: readonly ManagedContainerLogTarget[];
    } = {}
): Promise<void> {
    if (
        !(options.requireRoot?.() ?? process.getuid?.() === 0) ||
        !Number.isSafeInteger(groupId) ||
        groupId < 0
    ) {
        throw failure();
    }
    const opened: OpenedManagedLogTarget[] = [];
    try {
        for (const target of options.targets ?? targets) {
            const candidate = await openTarget(target);
            if (candidate !== undefined) opened.push(candidate);
        }
        for (const target of opened) {
            const created = await Promise.all(
                target.missingFileNames.map((fileName) =>
                    openOrCreateMissingFile(target, fileName)
                )
            );
            (target.files as OpenedManagedLogFile[]).push(...created);
        }
        for (const target of opened) {
            await target.directory.chown(target.directoryStatus.uid, groupId);
            await target.directory.chmod(0o2770);
            for (const file of target.files) {
                await file.handle.chown(file.ownerId, groupId);
                await file.handle.chmod(0o660);
            }
        }
    } catch {
        throw failure();
    } finally {
        await Promise.all(opened.map((target) => closeTarget(target)));
    }
}

if (import.meta.main) {
    const argument = process.argv[2] ?? "";
    if (process.argv.length !== 3 || !argument.startsWith("--group-id=")) {
        throw failure();
    }
    const value = argument.slice("--group-id=".length);
    if (!groupIdPattern.test(value)) throw failure();
    await provisionManagedContainerLogs(Number(value));
    process.stdout.write("Managed container log access provisioned.\n");
}
