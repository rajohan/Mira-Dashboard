import { constants, type BigIntStats } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

const failureMessage = "Managed application log migration failed";
const logsDirectory = "/home/ubuntu/projects/mira-dashboard/production/state/logs";
const logFileNames = Object.freeze([
    "web-stdout.log",
    "web-stderr.log",
    "worker-stdout.log",
    "worker-stderr.log",
]);
const directoryFlags =
    constants.O_RDONLY |
    constants.O_DIRECTORY |
    constants.O_NOFOLLOW |
    constants.O_NONBLOCK;
const fileFlags =
    constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const userIdPattern = /^(?:0|[1-9]\d{0,9})$/u;

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

function trustedDirectory(status: BigIntStats, userId: number): boolean {
    return (
        status.isDirectory() &&
        !status.isSymbolicLink() &&
        status.uid === BigInt(userId) &&
        (status.mode & 0o7777n) === 0o700n
    );
}

function trustedLogFile(
    status: BigIntStats,
    directoryStatus: BigIntStats,
    userId: number
): boolean {
    return (
        status.isFile() &&
        !status.isSymbolicLink() &&
        status.nlink === 1n &&
        status.dev === directoryStatus.dev &&
        (status.uid === 0n || status.uid === BigInt(userId)) &&
        (status.mode & 0o7777n) === 0o600n
    );
}

/**
 * Migrates the four fixed application log files from the legacy root launcher owner.
 * Missing fixed files are created only after non-root state preparation has admitted the
 * private logs directory.
 * @param userId Canonical production service user id.
 * @param options Deterministic test-only identity and path seams.
 */
export async function migrateManagedApplicationLogs(
    userId: number,
    options: {
        readonly directoryPath?: string;
        readonly requireRoot?: () => boolean;
    } = {}
): Promise<void> {
    if (
        !(options.requireRoot?.() ?? process.getuid?.() === 0) ||
        !Number.isSafeInteger(userId) ||
        userId < 1
    ) {
        throw failure();
    }
    const directoryPath = options.directoryPath ?? logsDirectory;
    let directory: FileHandle | undefined;
    const files: FileHandle[] = [];
    try {
        try {
            directory = await open(directoryPath, directoryFlags);
        } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw error;
        }
        const [directoryStatus, canonical] = await Promise.all([
            directory.stat({ bigint: true }),
            realpath(`/proc/self/fd/${directory.fd}`),
        ]);
        if (canonical !== directoryPath || !trustedDirectory(directoryStatus, userId)) {
            throw failure();
        }
        for (const fileName of logFileNames) {
            let file: FileHandle | undefined;
            try {
                file = await open(
                    path.join(`/proc/self/fd/${directory.fd}`, fileName),
                    fileFlags,
                    0o600
                );
                const status = await file.stat({ bigint: true });
                if (!trustedLogFile(status, directoryStatus, userId)) throw failure();
                files.push(file);
                file = undefined;
            } finally {
                await close(file);
            }
        }
        for (const file of files) {
            await file.chown(userId, Number(directoryStatus.gid));
            await file.chmod(0o600);
        }
    } catch {
        throw failure();
    } finally {
        await Promise.all(files.map((file) => close(file)));
        await close(directory);
    }
}

if (import.meta.main) {
    const argument = process.argv[2] ?? "";
    if (process.argv.length !== 3 || !argument.startsWith("--user-id=")) {
        throw failure();
    }
    const value = argument.slice("--user-id=".length);
    if (!userIdPattern.test(value) || Number(value) === 0) throw failure();
    await migrateManagedApplicationLogs(Number(value));
    process.stdout.write("Managed application logs migrated.\n");
}
