import { afterEach, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
    getCacheRefreshMetrics,
    recordCacheRefreshCoalesced,
    recordCacheRefreshFinished,
    recordCacheRefreshRequest,
    recordCacheRefreshStarted,
    resetCacheRefreshMetricsForTests,
    resolveCacheRefreshMetricsSnapshotPath,
    startCacheRefreshMetricsSession,
    stopCacheRefreshMetricsSession,
} from "../src/services/cacheRefreshMetrics.ts";

const temporaryRoots: string[] = [];

function temporaryRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "mira-cache-refresh-metrics-"));
    temporaryRoots.push(root);
    return root;
}

async function readText(stream: ReadableStream<Uint8Array>): Promise<string> {
    return new Response(stream).text();
}

afterEach(() => {
    resetCacheRefreshMetricsForTests();
    for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
    }
});

describe("cache refresh runtime metrics", () => {
    it("publishes worker-owned counters for the separate production web process", async () => {
        const runtimeRoot = temporaryRoot();
        const environment = {
            NODE_ENV: "production",
            XDG_RUNTIME_DIR: runtimeRoot,
        };
        const snapshotPath = resolveCacheRefreshMetricsSnapshotPath(environment);
        expect(snapshotPath).toBe(
            path.join(runtimeRoot, "mira-dashboard", "cache-refresh-metrics.json")
        );

        startCacheRefreshMetricsSession({ environment });
        recordCacheRefreshRequest();
        recordCacheRefreshStarted();
        recordCacheRefreshCoalesced();
        recordCacheRefreshFinished(12.345, true);

        expect(getCacheRefreshMetrics()).toEqual({
            active: 0,
            averageDurationMs: 12.35,
            coalesced: 1,
            failures: 1,
            lastDurationMs: 12.35,
            maxDurationMs: 12.35,
            refreshes: 1,
            requests: 1,
            totalDurationMs: 12.35,
        });
        expect(statSync(path.dirname(snapshotPath!)).mode & 0o777).toBe(0o700);
        expect(statSync(snapshotPath!).mode & 0o777).toBe(0o600);

        const moduleUrl = pathToFileURL(
            path.resolve(import.meta.dirname, "../src/services/cacheRefreshMetrics.ts")
        ).href;
        const child = Bun.spawn({
            cmd: [
                process.execPath,
                "--eval",
                `const metrics = await import(${JSON.stringify(moduleUrl)});
                 console.log(JSON.stringify(metrics.getCacheRefreshMetrics()));`,
            ],
            env: {
                ...process.env,
                NODE_ENV: "production",
                XDG_RUNTIME_DIR: runtimeRoot,
            },
            stderr: "pipe",
            stdout: "pipe",
        });
        const [exitCode, stderr, stdout] = await Promise.all([
            child.exited,
            readText(child.stderr),
            readText(child.stdout),
        ]);
        expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
        expect(JSON.parse(stdout)).toEqual(getCacheRefreshMetrics());

        stopCacheRefreshMetricsSession();
        expect(existsSync(snapshotPath!)).toBe(false);
    });

    it("fails soft on missing or malformed runtime snapshots", () => {
        const runtimeRoot = temporaryRoot();
        const environment = {
            NODE_ENV: "production",
            XDG_RUNTIME_DIR: runtimeRoot,
        };
        expect(
            resolveCacheRefreshMetricsSnapshotPath({
                NODE_ENV: "production",
                XDG_RUNTIME_DIR: "relative-runtime",
            })
        ).toBeUndefined();
        const snapshotPath = resolveCacheRefreshMetricsSnapshotPath(environment)!;
        expect(getCacheRefreshMetrics({ environment })).toEqual({
            active: 0,
            averageDurationMs: 0,
            coalesced: 0,
            failures: 0,
            lastDurationMs: 0,
            maxDurationMs: 0,
            refreshes: 0,
            requests: 0,
            totalDurationMs: 0,
        });

        mkdirSync(path.dirname(snapshotPath), { mode: 0o700, recursive: true });
        writeFileSync(snapshotPath, '{"version":1,"metrics":"invalid"}\n', {
            encoding: "utf8",
            flag: "wx",
            mode: 0o600,
        });
        expect(readFileSync(snapshotPath, "utf8")).toContain('"invalid"');
        expect(getCacheRefreshMetrics({ environment })).toEqual({
            active: 0,
            averageDurationMs: 0,
            coalesced: 0,
            failures: 0,
            lastDurationMs: 0,
            maxDurationMs: 0,
            refreshes: 0,
            requests: 0,
            totalDurationMs: 0,
        });

        rmSync(snapshotPath);
        writeFileSync(
            snapshotPath,
            `${JSON.stringify({
                instanceId: Bun.randomUUIDv7(),
                metrics: {
                    active: 0,
                    averageDurationMs: 4,
                    coalesced: 0,
                    failures: 0,
                    lastDurationMs: 4,
                    maxDurationMs: 4,
                    refreshes: 1,
                    requests: 1,
                    totalDurationMs: 4,
                },
                pid: 999_999_999,
                startedAt: "2026-07-30T08:00:00.000Z",
                version: 1,
            })}\n`,
            { encoding: "utf8", flag: "wx", mode: 0o600 }
        );
        expect(getCacheRefreshMetrics({ environment }).requests).toBe(0);
    });
});
