import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import path from "node:path";

export function isRealDirectory(directoryPath: string): boolean {
    try {
        const stat = lstatSync(directoryPath);
        return stat.isDirectory() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

export function isRealRegularFile(filePath: string): boolean {
    try {
        const stat = lstatSync(filePath);
        return stat.isFile() && !stat.isSymbolicLink();
    } catch {
        return false;
    }
}

export function ensurePrivateSingleLinkFile(filePath: string, label: string): void {
    if (!existsSync(filePath)) return;
    const stat = lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
        throw new Error(`${label} must be a single-link real regular file`);
    }
    chmodSync(filePath, 0o600);
}

export function ensureRealDirectory(directoryPath: string): void {
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    if (!isRealDirectory(directoryPath)) {
        throw new Error(`Preview path must be a real directory: ${directoryPath}`);
    }
    chmodSync(directoryPath, 0o700);
}

export function ensureRealDirectoryPreservingExistingMode(
    directoryPath: string
): void {
    const didExist = existsSync(directoryPath);
    mkdirSync(directoryPath, { mode: 0o700, recursive: true });
    if (!isRealDirectory(directoryPath)) {
        throw new Error(`Preview path must be a real directory: ${directoryPath}`);
    }
    if (!didExist) chmodSync(directoryPath, 0o700);
}

export function isPathStrictlyWithin(candidate: string, root: string): boolean {
    const relative = path.relative(path.resolve(root), path.resolve(candidate));
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}
