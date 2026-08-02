import { Database } from "bun:sqlite";
import fs from "node:fs";
import path from "node:path";

import { type RestoreValidator } from "./model.ts";

export function quickCheck(database: Database): void {
    const rows = database.query("PRAGMA quick_check").all() as Array<
        Record<string, unknown>
    >;
    if (
        rows.length !== 1 ||
        Object.values(rows[0] ?? {}).every(
            (value) => typeof value !== "string" || value.toLowerCase() !== "ok"
        )
    ) {
        throw new Error(`SQLite restore verification failed: ${JSON.stringify(rows)}`);
    }
}

export function verifyRestoredCopy(
    backupPath: string,
    backupDirectory: string,
    validate?: RestoreValidator,
    exercise?: RestoreValidator
): void {
    const restoreDirectory = fs.mkdtempSync(
        path.join(backupDirectory, ".restore-check-"),
        { encoding: "utf8" }
    );
    fs.chmodSync(restoreDirectory, 0o700);
    const restoredPath = path.join(restoreDirectory, "restored.db");
    try {
        fs.copyFileSync(backupPath, restoredPath, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(restoredPath, 0o600);
        const restoredDatabase = exercise
            ? new Database(restoredPath)
            : new Database(restoredPath, { readonly: true });
        try {
            if (!exercise) {
                restoredDatabase.run("PRAGMA query_only = ON");
            }
            quickCheck(restoredDatabase);
            validate?.(restoredDatabase);
            if (exercise) {
                exercise(restoredDatabase);
                quickCheck(restoredDatabase);
            }
        } finally {
            restoredDatabase.close();
        }
    } finally {
        fs.rmSync(restoreDirectory, { force: true, recursive: true });
    }
}

export function assertRealRegularFile(filePath: string, label: string): fs.Stats {
    const fileStat = fs.lstatSync(filePath);
    if (fileStat.isSymbolicLink() || !fileStat.isFile() || fileStat.nlink !== 1) {
        throw new Error(`${label} must be a real single-link regular file`);
    }
    return fileStat;
}

export function syncFile(filePath: string): void {
    const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}

export function syncDirectory(directoryPath: string): void {
    const descriptor = fs.openSync(directoryPath, fs.constants.O_RDONLY);
    try {
        fs.fsyncSync(descriptor);
    } finally {
        fs.closeSync(descriptor);
    }
}
