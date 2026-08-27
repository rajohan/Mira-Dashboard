import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, renameSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { formatStartupFailure } from "../../../shared/startupFailure.ts";
import { createProjectFileLogDestination } from "./projectFileLogSink.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
    await Promise.all(
        temporaryDirectories
            .splice(0)
            .map((directory) => rm(directory, { force: true, recursive: true }))
    );
});

async function logsDirectory(): Promise<string> {
    const root = await mkdtemp(path.join(tmpdir(), "mira-project-logs-"));
    temporaryDirectories.push(root);
    const logs = path.join(root, "logs");
    await mkdir(logs, { mode: 0o700 });
    await chmod(logs, 0o700);
    return logs;
}

describe("project-local log destination", () => {
    test.each(["web", "worker"] as const)(
        "timestamps the %s process fallback before the file sink is available",
        (processRole) => {
            expect(
                formatStartupFailure(processRole, new Date("2026-08-27T20:00:00.000Z"))
            ).toBe(
                `2026-08-27T20:00:00.000Z Mira Dashboard ${processRole} startup failed\n`
            );
        }
    );

    test("writes primary and fallback logs with private bounded files", async () => {
        const logs = await logsDirectory();
        const destination = createProjectFileLogDestination(logs, "web");

        destination.sink.write("primary\n", "info");
        destination.fallbackWrite("fallback\n");
        destination.sink.flush?.();
        destination.sink.flush?.();

        expect(await readFile(path.join(logs, "web.ndjson"), "utf8")).toBe("primary\n");
        expect(await readFile(path.join(logs, "web-fallback.ndjson"), "utf8")).toBe(
            "fallback\n"
        );
        const logStatus = await lstat(path.join(logs, "web.ndjson"));
        expect(Number(logStatus.mode & 0o7777)).toBe(0o600);
        expect(() => destination.sink.write("late\n", "info")).toThrow(
            "Project-local log destination is invalid"
        );
    });

    test("rejects permissive directories and symbolic log files", async () => {
        const permissiveLogs = await logsDirectory();
        await chmod(permissiveLogs, 0o755);
        expect(() => createProjectFileLogDestination(permissiveLogs, "worker")).toThrow(
            "Project-local log destination is invalid"
        );

        const linkedLogs = await logsDirectory();
        const outside = path.join(path.dirname(linkedLogs), "outside.ndjson");
        await symlink(outside, path.join(linkedLogs, "web.ndjson"));
        expect(() => createProjectFileLogDestination(linkedLogs, "web")).toThrow(
            "Project-local log destination is invalid"
        );
    });

    test("rejects a directory-entry swap after holding its descriptor", async () => {
        const logs = await logsDirectory();
        const displaced = path.join(path.dirname(logs), "displaced-logs");
        let replaced = false;

        expect(() =>
            createProjectFileLogDestination(logs, "worker", {
                afterDirectoryOpen() {
                    replaced = true;
                    renameSync(logs, displaced);
                    mkdirSync(logs, { mode: 0o700 });
                },
            })
        ).toThrow("Project-local log destination is invalid");
        expect(replaced).toBe(true);
    });

    test("rotates its own structured stream before exhausting the byte budget", async () => {
        const logs = await logsDirectory();
        const destination = createProjectFileLogDestination(logs, "worker", {
            maximumPrimaryBytes: 12,
        });

        destination.sink.write("first\n", "info");
        destination.sink.write("second\n", "warn");
        destination.sink.flush?.();

        expect(await readFile(path.join(logs, "worker.previous.ndjson"), "utf8")).toBe(
            "first\n"
        );
        expect(await readFile(path.join(logs, "worker.ndjson"), "utf8")).toBe("second\n");
        const currentStatus = await lstat(path.join(logs, "worker.ndjson"));
        expect(Number(currentStatus.mode & 0o7777)).toBe(0o600);
    });
});
