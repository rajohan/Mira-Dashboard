import { dlopen, FFIType, read } from "bun:ffi";

const renameNoReplaceFlag = 1;
const renameExchangeFlag = 2;
const renameReplaceFlag = 0;
const childNamePattern = /^(?!\.{1,2}$)[^/\\\0]{1,255}$/u;

const libc = dlopen("libc.so.6", {
    renameat2: {
        args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
        returns: FFIType.i32,
    },
    __errno_location: { args: [], returns: FFIType.ptr },
});

export type LinuxRename = (
    directoryFd: number,
    leftName: string,
    rightName: string
) => void;

export type LinuxRenameExchange = LinuxRename;
export type LinuxRenameNoReplace = LinuxRename;
export type LinuxRenameReplace = LinuxRename;

const errnoCode = new Map<number, string>([
    [1, "EPERM"],
    [2, "ENOENT"],
    [13, "EACCES"],
    [17, "EEXIST"],
    [40, "ELOOP"],
]);

class LinuxRenameError extends Error {
    public readonly code: string | undefined;
    public readonly errno: number;

    public constructor(errno: number) {
        super("Linux rename failed");
        this.name = "LinuxRenameError";
        this.errno = errno;
        this.code = errnoCode.get(errno);
    }
}

function cString(value: string): Buffer {
    return Buffer.from(`${value}\0`, "utf8");
}

function rename(
    directoryFd: number,
    leftName: string,
    rightName: string,
    flag: number
): void {
    if (
        process.platform !== "linux" ||
        !Number.isSafeInteger(directoryFd) ||
        directoryFd < 0 ||
        !childNamePattern.test(leftName) ||
        !childNamePattern.test(rightName) ||
        leftName === rightName
    ) {
        throw new TypeError("Linux rename input is invalid");
    }
    const result = libc.symbols.renameat2(
        directoryFd,
        cString(leftName),
        directoryFd,
        cString(rightName),
        flag
    );
    if (result !== 0) {
        const errnoPointer = libc.symbols.__errno_location();
        if (errnoPointer === null) throw new Error("Linux rename failed");
        throw new LinuxRenameError(read.i32(errnoPointer));
    }
}

/**
 * Atomically exchanges two exact children of one already-open Linux directory.
 * This is the worker-only CAS commit primitive; it never accepts host paths.
 */
export const linuxRenameExchange: LinuxRenameExchange = (
    directoryFd,
    leftName,
    rightName
) => {
    rename(directoryFd, leftName, rightName, renameExchangeFlag);
};

/** Atomically publishes one staged child only when the destination is absent. */
export const linuxRenameNoReplace: LinuxRenameNoReplace = (
    directoryFd,
    leftName,
    rightName
) => {
    rename(directoryFd, leftName, rightName, renameNoReplaceFlag);
};

/** Atomically replaces one exact sibling with another beneath a held directory. */
export const linuxRenameReplace: LinuxRenameReplace = (
    directoryFd,
    leftName,
    rightName
) => {
    rename(directoryFd, leftName, rightName, renameReplaceFlag);
};
