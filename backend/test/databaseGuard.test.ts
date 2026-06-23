import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "bun:test";

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

describe("database test safety guard", () => {
    it("refuses to open a non-temporary database while running tests", async () => {
        const root = await mkdtemp(path.join(tmpdir(), "mira-db-guard-test-"));
        const unsafeDatabasePath = path.resolve(
            import.meta.dirname,
            "../data/mira-dashboard.db"
        );
        const databaseModuleUrl = pathToFileURL(
            path.resolve(import.meta.dirname, "../src/database.ts")
        ).href;

        try {
            const child = Bun.spawn({
                cmd: [
                    process.execPath,
                    "--eval",
                    `await import(${JSON.stringify(databaseModuleUrl)});`,
                ],
                env: {
                    ...process.env,
                    MIRA_DASHBOARD_DB_PATH: unsafeDatabasePath,
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

            expect(exitCode).not.toBe(0);
            expect(stderr).toContain(
                "Refusing to open non-temporary Dashboard test database"
            );
            expect(existsSync(unsafeDatabasePath)).toBe(false);
        } finally {
            await rm(root, { force: true, recursive: true });
        }
    });
});
