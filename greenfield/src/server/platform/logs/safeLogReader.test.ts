import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
    appendFile,
    link,
    mkdir,
    mkdtemp,
    open,
    rename,
    rm,
    symlink,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { logReadWindowMaximumBytes } from "../../../contracts/logs.ts";
import { logRotationEpochProjectionFileName } from "../../../shared/logRotationEpochProjection.ts";
import type { ManagedLogManifest } from "../../../worker/logs/managedLogManifest.ts";
import { createManagedLogRotationEngine } from "../../../worker/logs/managedLogRotation.ts";
import { createLogRotationEpochProbe } from "./logRotationEpochProbe.ts";
import * as redaction from "./redaction.ts";
import {
    createSafeLogReader,
    logSearchMaximumInspectedLines,
    SafeLogReaderError,
} from "./safeLogReader.ts";
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

async function copytruncate(source: string, replacement: string) {
    const file = await open(source, "r+");
    const before = await file.stat({ bigint: true });
    try {
        await file.truncate(0);
        await file.sync();
        await file.writeFile(replacement);
        await file.sync();
        return { after: await file.stat({ bigint: true }), before };
    } finally {
        await file.close();
    }
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
            [
                "password=hunter2",
                '{"password":"fixture private suffix","message":"public failure"}',
                'Authorization: Digest username="fixture", nonce="fixture-digest-nonce"',
                "Cookie: session=fixture-cookie-value; theme=dark",
                "Set-Cookie: session=fixture-set-cookie-value; HttpOnly",
                "public failure",
                "",
            ].join("\n")
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
        for (const query of [
            "private suffix",
            "digest-nonce",
            "cookie-value",
            "set-cookie-value",
        ]) {
            const suffixSearch = await reader.search({
                limit: 10,
                query,
                sourceId: "dashboard.web.stderr",
            });
            expect(suffixSearch.lines).toEqual([]);
        }
        expect(redactedSearch.lines[0]?.line).toContain("[REDACTED]");
    });

    test("bounds redaction work while preserving the newest search results", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stderr.log");
        const older = "match older\n";
        const filler = "ordinary\n".repeat(logSearchMaximumInspectedLines);
        await writeFile(source, `${older}${filler}match newer one\nmatch newer two\n`);
        const redact = spyOn(redaction, "redactLogLine");
        try {
            const output = await reader.search({
                limit: 2,
                query: "match",
                sourceId: "dashboard.web.stderr",
            });
            const repeated = await reader.search({
                limit: 2,
                query: "match",
                sourceId: "dashboard.web.stderr",
            });

            expect(output.lines.map(({ line }) => line)).toEqual([
                "match newer one",
                "match newer two",
            ]);
            expect(output.lines.map(({ id }) => id)).toEqual(
                repeated.lines.map(({ id }) => id)
            );
            expect(output.hasEarlier).toBe(true);
            expect(redact).toHaveBeenCalledTimes(logSearchMaximumInspectedLines * 2);
        } finally {
            redact.mockRestore();
        }
    });

    test("keeps newline-heavy search redaction work within the deterministic line budget", async () => {
        const { dashboard, reader } = await fixture();
        await writeFile(
            path.join(dashboard, "web-stderr.log"),
            Buffer.alloc(logReadWindowMaximumBytes, 10)
        );
        const redact = spyOn(redaction, "redactLogLine");
        try {
            const output = await reader.search({
                limit: 500,
                query: "not present",
                sourceId: "dashboard.web.stderr",
            });

            expect(output.lines).toEqual([]);
            expect(output.hasEarlier).toBe(true);
            expect(output.scannedBytes).toBeLessThanOrEqual(logReadWindowMaximumBytes);
            expect(redact).toHaveBeenCalledTimes(logSearchMaximumInspectedLines);
        } finally {
            redact.mockRestore();
        }
    });

    test("keeps existing redacted line ids stable across ordinary appends", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        await writeFile(source, "password=first-private-value\n");
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        await appendFile(source, "password=second-private-value\n");
        const second = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        expect(first.lines[0]?.line).toBe("password=[REDACTED]");
        expect(second.lines[0]?.line).toBe("password=[REDACTED]");
        expect(second.lines[1]?.line).toBe("password=[REDACTED]");
        expect(second.lines[0]?.id).toBe(first.lines[0]?.id);
        expect(JSON.stringify(second)).not.toContain("private-value");
    });

    test("keeps separate overlap verification within the read budget", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        await writeFile(source, "checkpoint\n");
        await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        const row = `${"x".repeat(1024)}\n`;
        const appended = row.repeat(
            Math.ceil((logReadWindowMaximumBytes + 8192) / Buffer.byteLength(row))
        );
        await appendFile(source, appended);

        const output = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        const repeated = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        expect(output.scannedBytes).toBeLessThanOrEqual(logReadWindowMaximumBytes);
        expect(repeated.lines.map(({ id }) => id)).toEqual(
            output.lines.map(({ id }) => id)
        );
    });

    test("retains only the bounded tail while scanning a newline-heavy read window", async () => {
        const { dashboard, reader } = await fixture();
        await writeFile(
            path.join(dashboard, "web-stdout.log"),
            Buffer.alloc(logReadWindowMaximumBytes, 10)
        );

        const output = await reader.tail({
            limit: 500,
            sourceId: "dashboard.web.stdout",
        });

        expect(output.lines).toHaveLength(500);
        expect(output.hasEarlier).toBe(true);
        expect(output.scannedBytes).toBeLessThanOrEqual(logReadWindowMaximumBytes);
    });

    test("frames line identity tuples so offset and text boundaries cannot collide", async () => {
        const { dashboard, reader } = await fixture();
        await writeFile(path.join(dashboard, "web-stdout.log"), "\n23\n1234567\n3\n");

        const output = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        const ambiguousPair = output.lines.filter(
            ({ line }) => line === "23" || line === "3"
        );

        expect(ambiguousPair).toHaveLength(2);
        expect(new Set(ambiguousPair.map(({ id }) => id)).size).toBe(2);
    });

    test("fails the read when the worker epoch changes across the source observation", async () => {
        const { catalog, dashboard } = await fixture();
        await writeFile(path.join(dashboard, "web-stdout.log"), "line\n");
        let reads = 0;
        const reader = createSafeLogReader(catalog, () => 200, {
            epoch() {
                reads += 1;
                return Promise.resolve(
                    reads === 1
                        ? "019feb02-8b7d-7062-94c6-2708cc994799"
                        : "019feb02-8b7d-7062-94c6-2708cc99479a"
                );
            },
        });

        const error = await failure(() =>
            reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" })
        );
        expect(error.reason).toBe("source-changed");
    });

    test("maps a corrupt worker marker to the fixed unavailable reader failure", async () => {
        const { catalog, dashboard, root } = await fixture();
        const maintenance = path.join(root, "maintenance");
        await mkdir(maintenance, { mode: 0o700 });
        await writeFile(path.join(dashboard, "web-stdout.log"), "line\n");
        await writeFile(
            path.join(maintenance, logRotationEpochProjectionFileName),
            "corrupt marker content\n",
            { mode: 0o600 }
        );
        const reader = createSafeLogReader(
            catalog,
            () => 200,
            createLogRotationEpochProbe({ logMaintenanceRoot: maintenance })
        );

        const error = await failure(() =>
            reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" })
        );
        expect(error.reason).toBe("unavailable");
        expect(JSON.stringify(error)).not.toContain("corrupt marker content");
        expect(JSON.stringify(error)).not.toContain(root);
    });

    test("changes line identity when rotation replaces the source inode", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        const rotated = path.join(dashboard, "web-stdout.previous.log");
        await writeFile(source, "same line\n");
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });

        await rename(source, rotated);
        await writeFile(source, "same line\n");
        const replacement = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });

        expect(replacement.lines[0]?.line).toBe(first.lines[0]?.line);
        expect(replacement.lines[0]?.id).not.toBe(first.lines[0]?.id);
        await appendFile(source, "ordinary append\n");
        const appended = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        expect(appended.lines[0]?.id).toBe(replacement.lines[0]?.id);
    });

    test("changes line identity after copytruncate reuses the inode and offset", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        await writeFile(source, "same line\n");
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        const { after, before } = await copytruncate(source, "same line\n");
        expect(after.dev).toBe(before.dev);
        expect(after.ino).toBe(before.ino);

        const replacement = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        expect(replacement.lines[0]?.line).toBe(first.lines[0]?.line);
        expect(replacement.lines[0]?.id).not.toBe(first.lines[0]?.id);
    });

    test("detects rewritten overlap when copytruncate regrows past the prior size", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        const original = "same line\nold tail\n";
        const rewritten = "same line\nnew replacement tail that is longer\n";
        expect(Buffer.byteLength(rewritten)).toBeGreaterThan(Buffer.byteLength(original));
        await writeFile(source, original);
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });

        const { after, before } = await copytruncate(source, rewritten);
        expect(after.dev).toBe(before.dev);
        expect(after.ino).toBe(before.ino);
        const replacement = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });

        expect(replacement.lines[0]?.line).toBe(first.lines[0]?.line);
        expect(replacement.lines[0]?.id).not.toBe(first.lines[0]?.id);
    });

    test("advances before exact-prefix regrowth when a copytruncate empty state is observed", async () => {
        const { dashboard, reader } = await fixture();
        const source = path.join(dashboard, "web-stdout.log");
        await writeFile(source, "same line\n");
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        const file = await open(source, "r+");
        try {
            await file.truncate(0);
            await file.sync();
            const empty = await reader.tail({
                limit: 10,
                sourceId: "dashboard.web.stdout",
            });
            expect(empty.lines).toEqual([]);

            await file.writeFile("same line\nadditional line\n");
            await file.sync();
        } finally {
            await file.close();
        }
        const replacement = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        expect(replacement.lines[0]?.line).toBe(first.lines[0]?.line);
        expect(replacement.lines[0]?.id).not.toBe(first.lines[0]?.id);
    });

    test("uses the worker marker when copytruncate regrows before the next poll", async () => {
        const { catalog, dashboard, root } = await fixture();
        const maintenance = path.join(root, "maintenance");
        await mkdir(maintenance, { mode: 0o700 });
        const source = path.join(dashboard, "web-stdout.log");
        await writeFile(source, "same line\n", { mode: 0o600 });
        const reader = createSafeLogReader(
            catalog,
            () => 200,
            createLogRotationEpochProbe({ logMaintenanceRoot: maintenance })
        );
        const first = await reader.tail({ limit: 10, sourceId: "dashboard.web.stdout" });
        const manifest: ManagedLogManifest = {
            archiveTargets: [],
            fileTargets: [
                {
                    compress: false,
                    filePath: source,
                    id: "dashboard.web.stdout",
                    maximumSizeBytes: 1,
                    maximumSourceBytes: 1024,
                    retentionAgeMs: 100_000,
                    retentionCount: 1,
                    strategy: "copytruncate",
                    trustedOwnerIds: [fixtureOwnerId],
                },
            ],
            lockPath: path.join(maintenance, "managed.lock"),
            statePath: path.join(maintenance, "managed-state.json"),
        };

        await createManagedLogRotationEngine({ manifest, now: () => 300 }).run();
        await appendFile(source, "same line\nadditional line\n");
        const replacement = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });

        expect(replacement.lines[0]?.line).toBe(first.lines[0]?.line);
        expect(replacement.lines[0]?.id).not.toBe(first.lines[0]?.id);
        await appendFile(source, "ordinary append\n");
        const appended = await reader.tail({
            limit: 10,
            sourceId: "dashboard.web.stdout",
        });
        expect(appended.lines[0]?.id).toBe(replacement.lines[0]?.id);
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
