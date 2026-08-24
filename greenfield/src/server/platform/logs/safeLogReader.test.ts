import { afterEach, describe, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createSafeLogReader, SafeLogReaderError } from "./safeLogReader.ts";
import { createLogSourceCatalog } from "./sourceCatalog.ts";

const temporaryDirectories: string[] = [];
const fixtureOwnerId = typeof process.getuid === "function" ? process.getuid() : 0;

async function fixture() {
    const root = await mkdtemp(path.join(tmpdir(), "mira-safe-log-"));
    temporaryDirectories.push(root);
    const dashboard = path.join(root, "dashboard");
    const host = path.join(root, "host");
    const openclaw = path.join(root, "openclaw");
    await Promise.all([mkdir(dashboard), mkdir(host), mkdir(openclaw)]);
    const catalog = createLogSourceCatalog({
        dashboardLogsRoot: dashboard,
        hostLogsRoot: host,
        hostOwnerIds: [fixtureOwnerId],
        now: () => 100,
        openClawLogsRoot: openclaw,
    });
    return {
        catalog,
        dashboard,
        host,
        openclaw,
        reader: createSafeLogReader(catalog, () => 200),
        root,
    };
}

afterEach(async () => {
    await Promise.all(
        temporaryDirectories.splice(0).map((root) => rm(root, { recursive: true }))
    );
});

async function failure(work: () => Promise<unknown>): Promise<SafeLogReaderError> {
    try {
        await work();
    } catch (error) {
        expect(error).toBeInstanceOf(SafeLogReaderError);
        return error as SafeLogReaderError;
    }
    throw new Error("Expected read to fail");
}

describe("safe named log reader", () => {
    test("returns a bounded newest tail with stable ids, severity, timestamps, and redaction", async () => {
        const { dashboard, reader } = await fixture();
        await writeFile(
            path.join(dashboard, "web-stdout.log"),
            [
                "first",
                '{"level":"info","time":"2026-08-09T12:34:56.000Z","msg":"ready"}',
                "Authorization: Bearer secret-value",
                "last error",
                "",
            ].join("\n")
        );
        const output = await reader.tail({ limit: 3, sourceId: "dashboard.web.stdout" });
        expect(output).toMatchObject({
            hasEarlier: true,
            observedAtMs: 200,
            sourceId: "dashboard.web.stdout",
        });
        expect(output.lines).toHaveLength(3);
        expect(output.lines.some(({ line }) => line.includes("[REDACTED]"))).toBe(true);
        expect(output.lines.some(({ line }) => line.includes("secret-value"))).toBe(
            false
        );
        expect(output.lines.at(-1)?.severity).toBe("error");

        const repeated = await reader.tail({
            limit: 3,
            sourceId: "dashboard.web.stdout",
        });
        expect(repeated.lines.map(({ id }) => id)).toEqual(
            output.lines.map(({ id }) => id)
        );
    });

    test("searches only redacted text so secrets do not form a match oracle", async () => {
        const { dashboard, reader } = await fixture();
        await writeFile(
            path.join(dashboard, "web-stderr.log"),
            "password=hunter2\npublic failure\n"
        );
        const secretSearch = await reader.search({
            limit: 10,
            query: "hunter2",
            sourceId: "dashboard.web.stderr",
        });
        const redactedSearch = await reader.search({
            limit: 10,
            query: "redacted",
            sourceId: "dashboard.web.stderr",
        });
        expect(secretSearch.lines).toEqual([]);
        expect(redactedSearch.lines[0]?.line).toContain("[REDACTED]");
    });

    test("derives stable line ids from redacted output rather than secret bytes", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        await writeFile(source, "password=first-private-value\n");
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        await writeFile(source, "password=second-private-value\n");
        const second = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        expect(first.lines[0]?.line).toBe("password=[REDACTED]");
        expect(second.lines[0]?.line).toBe("password=[REDACTED]");
        expect(second.lines[0]?.id).toBe(first.lines[0]?.id);
    });

    test("uses the source-specific owner policy for host and application logs", async () => {
        const { dashboard, host, reader } = await fixture();
        await Promise.all([
            writeFile(path.join(host, "syslog"), "host\n"),
            writeFile(path.join(dashboard, "web-stdout.log"), "dashboard\n"),
        ]);
        const hostTail = await reader.tail({ limit: 1, sourceId: "host.syslog" });
        const dashboardTail = await reader.tail({
            limit: 1,
            sourceId: "dashboard.web.stdout",
        });
        expect(hostTail.lines).toHaveLength(1);
        expect(dashboardTail.lines).toHaveLength(1);
    });

    test("rejects unknown, symlinked, hardlinked, and non-regular sources without retaining paths", async () => {
        const { dashboard, reader, root } = await fixture();
        const unknown = await failure(() =>
            reader.tail({ limit: 10, sourceId: "host.unknown" })
        );
        expect(unknown.reason).toBe("not-found");

        const outside = path.join(root, "outside.log");
        await writeFile(outside, "secret\n");
        await symlink(outside, path.join(dashboard, "web-stdout.log"));
        const symlinkFailure = await failure(() =>
            reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" })
        );
        expect(symlinkFailure.reason).toBe("unavailable");
        expect(JSON.stringify(symlinkFailure)).not.toContain(root);

        await rm(path.join(dashboard, "web-stdout.log"));
        await link(outside, path.join(dashboard, "web-stdout.log"));
        const hardlinkFailure = await failure(() =>
            reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" })
        );
        expect(hardlinkFailure.reason).toBe("unavailable");

        await rm(path.join(dashboard, "web-stdout.log"));
        await mkdir(path.join(dashboard, "web-stdout.log"));
        const directoryFailure = await failure(() =>
            reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" })
        );
        expect(directoryFailure.reason).toBe("unavailable");
    });
});
