import { afterAll, describe, expect, test } from "bun:test";
import { link, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { migrateManagedApplicationLogs } from "./provisioning/log-maintenance/migrateManagedApplicationLogs.ts";

const temporaryDirectories: string[] = [];

async function captureFailure(operation: Promise<void>): Promise<Error> {
    try {
        await operation;
    } catch (error) {
        return error as Error;
    }
    throw new Error("Expected managed application log migration to fail");
}

async function fixture(): Promise<{ readonly directory: string; readonly file: string }> {
    const root = await mkdtemp(path.join(os.tmpdir(), "mira-managed-app-logs-"));
    temporaryDirectories.push(root);
    const directory = path.join(root, "logs");
    const file = path.join(directory, "web-stdout.log");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(file, "entry\n", { mode: 0o600 });
    return { directory, file };
}

describe("managed application log migration", () => {
    test("readmits fixed private logs through held descriptors", async () => {
        const item = await fixture();
        const userId = process.getuid?.() ?? 1;

        await migrateManagedApplicationLogs(userId, {
            directoryPath: item.directory,
            requireRoot: () => true,
        });

        const status = await lstat(item.file);
        expect(status.uid).toBe(userId);
        expect(status.mode & 0o7777).toBe(0o600);
    });

    test("allows absent clean-host state", async () => {
        const root = await mkdtemp(path.join(os.tmpdir(), "mira-managed-app-missing-"));
        temporaryDirectories.push(root);
        expect(
            await migrateManagedApplicationLogs(process.getuid?.() ?? 1, {
                directoryPath: path.join(root, "missing"),
                requireRoot: () => true,
            })
        ).toBeUndefined();
    });

    test("rejects a symlink without changing its target", async () => {
        const item = await fixture();
        const external = path.join(path.dirname(item.directory), "external.log");
        await writeFile(external, "external\n", { mode: 0o640 });
        const externalBefore = await lstat(external);
        const externalMode = externalBefore.mode & 0o7777;
        await rm(item.file);
        await symlink(external, item.file);

        const failure = await captureFailure(
            migrateManagedApplicationLogs(process.getuid?.() ?? 1, {
                directoryPath: item.directory,
                requireRoot: () => true,
            })
        );
        expect(failure.message).toBe("Managed application log migration failed");
        const externalAfter = await lstat(external);
        expect(externalAfter.mode & 0o7777).toBe(externalMode);
    });

    test("rejects multiply linked application logs", async () => {
        const item = await fixture();
        await link(item.file, path.join(item.directory, "alias.log"));

        const failure = await captureFailure(
            migrateManagedApplicationLogs(process.getuid?.() ?? 1, {
                directoryPath: item.directory,
                requireRoot: () => true,
            })
        );
        expect(failure.message).toBe("Managed application log migration failed");
    });
});

afterAll(async () => {
    for (const directory of temporaryDirectories) {
        await rm(directory, { force: true, recursive: true });
    }
});
