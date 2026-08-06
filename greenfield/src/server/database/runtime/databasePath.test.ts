import { afterEach, describe, expect, test } from "bun:test";
import {
    chmod,
    link,
    mkdir,
    mkdtemp,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { DatabaseRuntimePathError } from "./databaseErrors.ts";
import {
    assertDatabasePathStillValid,
    dashboardDatabaseFileName,
    prepareDatabasePath,
} from "./databasePath.ts";

const temporaryDirectories: string[] = [];

async function privateTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "dashboard-db-path-"));
    temporaryDirectories.push(directory);
    await chmod(directory, 0o700);
    return directory;
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
    try {
        await promise;
        return new Error("Expected promise rejection");
    } catch (error) {
        return error;
    }
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

describe("database runtime path policy", () => {
    test("creates the fixed private database file and revalidates its identity", async () => {
        const directory = await privateTemporaryDirectory();
        const prepared = await prepareDatabasePath(directory, true);

        expect(prepared?.existed).toBe(false);
        expect(prepared?.filePath).toBe(path.join(directory, dashboardDatabaseFileName));
        await assertDatabasePathStillValid(prepared!);

        const reopened = await prepareDatabasePath(directory, true);
        expect(reopened?.existed).toBe(true);
        expect(reopened?.identity).toEqual(prepared?.identity);
    });

    test("does not create a missing database for validate-only startup", async () => {
        const directory = await privateTemporaryDirectory();
        expect(await prepareDatabasePath(directory, false)).toBeUndefined();
    });

    test("rejects noncanonical, permissive, and symlinked state directories", async () => {
        const directory = await privateTemporaryDirectory();
        expect(
            await rejectionOf(prepareDatabasePath(`${directory}/.`, true))
        ).toBeInstanceOf(DatabaseRuntimePathError);

        await chmod(directory, 0o750);
        expect(await rejectionOf(prepareDatabasePath(directory, true))).toBeInstanceOf(
            DatabaseRuntimePathError
        );

        await chmod(directory, 0o700);
        const linkPath = `${directory}-link`;
        temporaryDirectories.push(linkPath);
        await symlink(directory, linkPath, "dir");
        expect(await rejectionOf(prepareDatabasePath(linkPath, true))).toBeInstanceOf(
            DatabaseRuntimePathError
        );
    });

    test("rejects a replaceable state-directory entry beneath a writable parent", async () => {
        const parentDirectory = await privateTemporaryDirectory();
        const stateDirectory = path.join(parentDirectory, "state");
        await mkdir(stateDirectory, { mode: 0o700 });
        await chmod(parentDirectory, 0o777);

        const failure = await rejectionOf(prepareDatabasePath(stateDirectory, true));
        expect(failure).toBeInstanceOf(DatabaseRuntimePathError);
        expect(failure).toMatchObject({ reason: "state-directory-invalid" });
    });

    test("rejects symlinked, multiply linked, and permissive database files", async () => {
        const symlinkDirectory = await privateTemporaryDirectory();
        const symlinkTarget = path.join(symlinkDirectory, "target.db");
        await writeFile(symlinkTarget, "", { mode: 0o600 });
        await symlink(
            symlinkTarget,
            path.join(symlinkDirectory, dashboardDatabaseFileName)
        );
        expect(
            await rejectionOf(prepareDatabasePath(symlinkDirectory, true))
        ).toBeInstanceOf(DatabaseRuntimePathError);

        const hardlinkDirectory = await privateTemporaryDirectory();
        const databasePath = path.join(hardlinkDirectory, dashboardDatabaseFileName);
        await writeFile(databasePath, "", { mode: 0o600 });
        await link(databasePath, path.join(hardlinkDirectory, "second-link.db"));
        expect(
            await rejectionOf(prepareDatabasePath(hardlinkDirectory, true))
        ).toBeInstanceOf(DatabaseRuntimePathError);

        const modeDirectory = await privateTemporaryDirectory();
        const modePath = path.join(modeDirectory, dashboardDatabaseFileName);
        await writeFile(modePath, "", { mode: 0o644 });
        await chmod(modePath, 0o644);
        expect(
            await rejectionOf(prepareDatabasePath(modeDirectory, true))
        ).toBeInstanceOf(DatabaseRuntimePathError);
    });

    test("rejects unsafe SQLite journal, shared-memory, and WAL sidecars", async () => {
        for (const suffix of ["-journal", "-shm", "-wal"] as const) {
            const directory = await privateTemporaryDirectory();
            const target = path.join(directory, `target${suffix}`);
            await writeFile(target, "", { mode: 0o600 });
            await symlink(
                target,
                path.join(directory, `${dashboardDatabaseFileName}${suffix}`)
            );

            expect(
                await rejectionOf(prepareDatabasePath(directory, true))
            ).toBeInstanceOf(DatabaseRuntimePathError);
        }
    });

    test("detects database path replacement after preparation", async () => {
        const directory = await privateTemporaryDirectory();
        const prepared = await prepareDatabasePath(directory, true);
        if (!prepared) throw new Error("Expected a prepared database path");
        const replacement = path.join(directory, "replacement.db");
        await writeFile(replacement, "", { mode: 0o600 });
        await rename(replacement, prepared.filePath);

        expect(await rejectionOf(assertDatabasePathStillValid(prepared))).toBeInstanceOf(
            DatabaseRuntimePathError
        );
    });

    test("detects an unsafe sidecar introduced after preparation", async () => {
        const directory = await privateTemporaryDirectory();
        const prepared = await prepareDatabasePath(directory, true);
        if (!prepared) throw new Error("Expected a prepared database path");
        const target = path.join(directory, "sidecar-target");
        await writeFile(target, "", { mode: 0o600 });
        await symlink(target, `${prepared.filePath}-wal`);

        expect(await rejectionOf(assertDatabasePathStillValid(prepared))).toBeInstanceOf(
            DatabaseRuntimePathError
        );
    });

    test("detects state-directory policy drift after preparation", async () => {
        const directory = await privateTemporaryDirectory();
        const prepared = await prepareDatabasePath(directory, true);
        if (!prepared) throw new Error("Expected a prepared database path");
        await chmod(directory, 0o750);

        const failure = await rejectionOf(assertDatabasePathStillValid(prepared));
        expect(failure).toBeInstanceOf(DatabaseRuntimePathError);
        expect(failure).toMatchObject({ reason: "state-directory-invalid" });
    });

    test("detects parent-chain policy drift after preparation", async () => {
        const parentDirectory = await privateTemporaryDirectory();
        const stateDirectory = path.join(parentDirectory, "state");
        await mkdir(stateDirectory, { mode: 0o700 });
        const prepared = await prepareDatabasePath(stateDirectory, true);
        if (!prepared) throw new Error("Expected a prepared database path");
        await chmod(parentDirectory, 0o777);

        const failure = await rejectionOf(assertDatabasePathStillValid(prepared));
        expect(failure).toBeInstanceOf(DatabaseRuntimePathError);
        expect(failure).toMatchObject({ reason: "state-directory-invalid" });
    });
});
