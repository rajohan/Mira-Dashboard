import { describe, expect, test } from "bun:test";

import { createFixedSqliteLifecycleMaintenance } from "./fixedSqliteLifecycleMaintenance.ts";

const releaseRoot = "/srv/mira/releases/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const releaseId = "a".repeat(40);

function encoded(value: unknown): Uint8Array {
    return new TextEncoder().encode(`${JSON.stringify(value)}\n`);
}

describe("fixed SQLite lifecycle maintenance", () => {
    test("uses exact fixed argv and returns only a validated path-free result", async () => {
        const calls: string[][] = [];
        const maintenance = createFixedSqliteLifecycleMaintenance({
            executable: "/usr/bin/bun",
            migrationsDirectory: `${releaseRoot}/migrations`,
            process(argv, cwd, signal) {
                expect(cwd).toBe(releaseRoot);
                expect(signal).toBeInstanceOf(AbortSignal);
                calls.push([...argv]);
                const transition = argv
                    .find((value) => value.startsWith("--transition="))
                    ?.slice("--transition=".length);
                if (transition === undefined) throw new Error("missing transition");
                const createdAtMs = Number.parseInt(
                    transition.slice(0, 8) + transition.slice(9, 13),
                    16
                );
                return Promise.resolve({
                    exitCode: 0,
                    stderr: new Uint8Array(),
                    stdout: encoded({
                        processStatus: "SQLITE_MAINTENANCE",
                        result: {
                            backupBytes: 4096,
                            backupCreatedAtMs: createdAtMs,
                            checkpoint: {
                                busyFrames: 0,
                                checkpointedFrames: 2,
                                logFrames: 2,
                            },
                            completedAtMs: createdAtMs + 1,
                            retainedBackupBytes: 4096,
                            retainedBackupCount: 1,
                            status: "completed",
                        },
                    }),
                });
            },
            releaseId,
            releaseRoot,
            stateDirectory: "/srv/mira/production/state",
        });

        expect(maintenance.run()).resolves.toMatchObject({
            backupBytes: 4096,
            retainedBackupCount: 1,
            status: "completed",
        });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.slice(0, 6)).toEqual([
            "/usr/bin/bun",
            `${releaseRoot}/server/databaseMaintenance.js`,
            "--operation=sqlite-maintenance",
            `--migrations=${releaseRoot}/migrations`,
            `--release=${releaseId}`,
            "--state=/srv/mira/production/state",
        ]);
        expect(JSON.stringify(await maintenance.run())).not.toContain("/srv/");
    });

    test("fails closed on output, status, stderr, or argument authority drift", () => {
        expect(() =>
            createFixedSqliteLifecycleMaintenance({
                migrationsDirectory: "/tmp/unreviewed",
                releaseId,
                releaseRoot,
                stateDirectory: "/srv/mira/production/state",
            })
        ).toThrow("SQLite maintenance process failed");

        for (const output of [
            { exitCode: 1, stderr: new Uint8Array(), stdout: new Uint8Array() },
            {
                exitCode: 0,
                stderr: new TextEncoder().encode("private path"),
                stdout: new Uint8Array(),
            },
            {
                exitCode: 0,
                stderr: new Uint8Array(),
                stdout: encoded({ processStatus: "SQLITE_MAINTENANCE", result: {} }),
            },
        ]) {
            const maintenance = createFixedSqliteLifecycleMaintenance({
                executable: "/usr/bin/bun",
                migrationsDirectory: `${releaseRoot}/migrations`,
                process: () => Promise.resolve(output),
                releaseId,
                releaseRoot,
                stateDirectory: "/srv/mira/production/state",
            });
            expect(maintenance.run()).rejects.toThrow(
                "SQLite maintenance process failed"
            );
        }
    });
});
