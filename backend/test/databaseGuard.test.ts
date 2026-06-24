import { existsSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "bun:test";

const realTemporaryRoot = realpathSync(path.resolve(tmpdir()));
const realHomeRoot = realpathSync(path.resolve(homedir()));
const nonTemporaryRelativePath = path.relative(realTemporaryRoot, realHomeRoot);
const nonTemporaryTest =
    nonTemporaryRelativePath === "" ||
    (!nonTemporaryRelativePath.startsWith("..") &&
        !path.isAbsolute(nonTemporaryRelativePath))
        ? it.skip
        : it;

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

async function importDatabaseInChild(databasePath: string): Promise<{
    exitCode: number;
    stderr: string;
}> {
    const databaseModuleUrl = pathToFileURL(
        path.resolve(import.meta.dirname, "../src/database.ts")
    ).href;
    const child = Bun.spawn({
        cmd: [
            process.execPath,
            "--eval",
            `await import(${JSON.stringify(databaseModuleUrl)});`,
        ],
        env: {
            ...process.env,
            MIRA_DASHBOARD_DB_PATH: databasePath,
            NODE_ENV: "test",
        },
        stderr: "pipe",
        stdout: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
        child.exited,
        readText(child.stderr),
        readText(child.stdout),
    ]);
    return { exitCode, stderr };
}

describe("database test safety guard", () => {
    it("allows fresh database paths inside new temporary subdirectories", async () => {
        const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mira-db-guard-fresh-"));
        const databasePath = path.join(temporaryRoot, "nested", "dashboard.db");

        try {
            const { exitCode, stderr } = await importDatabaseInChild(databasePath);

            expect(exitCode).toBe(0);
            expect(stderr).toBe("");
            expect(existsSync(databasePath)).toBe(true);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
        }
    });

    nonTemporaryTest(
        "refuses to open a non-temporary database while running tests",
        async () => {
            const root = await mkdtemp(path.join(realHomeRoot, ".mira-db-guard-test-"));
            const unsafeDatabasePath = path.join(root, "mira-dashboard.db");

            try {
                const { exitCode, stderr } =
                    await importDatabaseInChild(unsafeDatabasePath);

                expect(exitCode).not.toBe(0);
                expect(stderr).toContain(
                    "Refusing to open non-temporary Dashboard test database"
                );
                expect(existsSync(unsafeDatabasePath)).toBe(false);
            } finally {
                await rm(root, { force: true, recursive: true });
            }
        }
    );

    it("refuses symlinked temporary database paths", async () => {
        const outsideRoot = await mkdtemp(
            path.join(import.meta.dirname, ".mira-db-guard-target-")
        );
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-db-guard-symlink-")
        );
        const outsideDatabasePath = path.join(outsideRoot, "target.db");
        const symlinkedDatabasePath = path.join(temporaryRoot, "dashboard.db");

        try {
            await writeFile(outsideDatabasePath, "");
            await symlink(outsideDatabasePath, symlinkedDatabasePath);
            const { exitCode, stderr } =
                await importDatabaseInChild(symlinkedDatabasePath);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain(
                "Refusing to open symlinked Dashboard test database"
            );
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
            await rm(outsideRoot, { force: true, recursive: true });
        }
    });

    it("refuses dangling symlinked temporary database paths", async () => {
        const outsideRoot = await mkdtemp(
            path.join(import.meta.dirname, ".mira-db-guard-dangling-target-")
        );
        const temporaryRoot = await mkdtemp(
            path.join(tmpdir(), "mira-db-guard-dangling-")
        );
        const missingOutsideDatabasePath = path.join(outsideRoot, "missing.db");
        const symlinkedDatabasePath = path.join(temporaryRoot, "dashboard.db");

        try {
            await mkdir(outsideRoot, { recursive: true });
            await symlink(missingOutsideDatabasePath, symlinkedDatabasePath);
            const { exitCode, stderr } =
                await importDatabaseInChild(symlinkedDatabasePath);

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain(
                "Refusing to open symlinked Dashboard test database"
            );
            expect(existsSync(missingOutsideDatabasePath)).toBe(false);
        } finally {
            await rm(temporaryRoot, { force: true, recursive: true });
            await rm(outsideRoot, { force: true, recursive: true });
        }
    });
});
