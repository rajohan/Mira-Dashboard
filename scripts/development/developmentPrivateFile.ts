import { constants } from "node:fs";
import { open } from "node:fs/promises";

const privateFileOpenFlags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const defaultMaximumBytes = 64 * 1024;

export interface DevelopmentPrivateFileReadOptions {
    readonly chmodMode?: number;
    readonly exactMode?: number;
    readonly forbiddenModeBits?: number;
    readonly maximumBytes?: number;
    readonly minimumBytes?: number;
}

function invalidPrivateFile(): Error {
    return new Error("Development private file is invalid");
}

/**
 * Opens, validates, optionally chmods, and reads one private regular file through one held fd.
 * @param filePath Absolute private-file path.
 * @param options Ownership, mode, and byte constraints applied to the held inode.
 * @returns UTF-8 contents read from the same inode that passed validation.
 */
export async function readDevelopmentPrivateFile(
    filePath: string,
    options: DevelopmentPrivateFileReadOptions = {}
): Promise<string> {
    const file = await open(filePath, privateFileOpenFlags);
    try {
        const status = await file.stat();
        const maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
        const userId =
            typeof process.getuid === "function" ? process.getuid() : undefined;
        const mode = status.mode & 0o777;
        if (
            userId === undefined ||
            !status.isFile() ||
            status.isSymbolicLink() ||
            status.uid !== userId ||
            (options.exactMode !== undefined && mode !== options.exactMode) ||
            (options.forbiddenModeBits !== undefined &&
                (mode & options.forbiddenModeBits) !== 0) ||
            (options.minimumBytes !== undefined && status.size < options.minimumBytes) ||
            status.size > maximumBytes
        ) {
            throw invalidPrivateFile();
        }
        if (options.chmodMode !== undefined) await file.chmod(options.chmodMode);
        const contents = Buffer.alloc(maximumBytes + 1);
        let bytesRead = 0;
        while (bytesRead < contents.byteLength) {
            const result = await file.read(
                contents,
                bytesRead,
                contents.byteLength - bytesRead,
                bytesRead
            );
            if (result.bytesRead === 0) break;
            bytesRead += result.bytesRead;
        }
        const finalStatus = await file.stat();
        if (
            finalStatus.dev !== status.dev ||
            finalStatus.ino !== status.ino ||
            finalStatus.size !== status.size ||
            finalStatus.size !== bytesRead ||
            (options.minimumBytes !== undefined && bytesRead < options.minimumBytes) ||
            bytesRead > maximumBytes
        ) {
            throw invalidPrivateFile();
        }
        return contents.subarray(0, bytesRead).toString("utf8");
    } finally {
        await file.close();
    }
}
