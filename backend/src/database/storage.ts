import fs from "node:fs";
import path from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

function assertSafeRegularFile(filePath: string): void {
    let fileStat: fs.Stats;
    try {
        fileStat = fs.lstatSync(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return;
        }
        throw error;
    }
    if (fileStat.isSymbolicLink() || !fileStat.isFile()) {
        throw new Error(`Refusing unsafe SQLite file path: ${filePath}`);
    }
}

export function secureDirectory(directoryPath: string): void {
    fs.mkdirSync(directoryPath, { mode: DIRECTORY_MODE, recursive: true });
    const directoryStat = fs.lstatSync(directoryPath);
    if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
        throw new Error(`Refusing unsafe SQLite directory path: ${directoryPath}`);
    }
    fs.chmodSync(directoryPath, DIRECTORY_MODE);
}

export function secureSqliteFilePermissions(databasePath: string): void {
    for (const filePath of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
        assertSafeRegularFile(filePath);
        if (fs.existsSync(filePath)) {
            fs.chmodSync(filePath, FILE_MODE);
        }
    }
}

export function prepareDatabaseStorage(databasePath: string): void {
    const dataDirectory = path.dirname(databasePath);
    secureDirectory(dataDirectory);
    assertSafeRegularFile(databasePath);

    const fileDescriptor = fs.openSync(
        databasePath,
        fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW ?? 0),
        FILE_MODE
    );
    fs.closeSync(fileDescriptor);
    fs.chmodSync(databasePath, FILE_MODE);
}

export function sqliteBackupDirectory(databasePath: string): string {
    return path.join(path.dirname(databasePath), "backups");
}
