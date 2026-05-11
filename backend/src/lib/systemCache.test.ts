import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { setCacheStoreDockerBinForTests } from "./cacheStore.js";

const originalPath = process.env.PATH;
const originalMode = process.env.FAKE_SYSTEM_CACHE_MODE;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!/usr/bin/node
const mode = process.env.FAKE_SYSTEM_CACHE_MODE || "fresh";
if (mode === "missing") {
  process.exit(0);
}
const status = mode === "stale" ? "stale" : "fresh";
const data = mode === "invalid" ? "not-json" : JSON.stringify({ version: { current: "v2026.5.4", latest: "v2026.5.5", updateAvailable: true, checkedAt: 1800000000000 }, doctorWarningCount: 2 });
process.stdout.write([
  "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta",
  "system.host\t" + data + "\tsystem\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\t2026-05-11T01:00:00.000Z\t" + status + "\tWARN\tCareful\t2\t{\"producer\":\"test\"}",
  "",
].join("\n"));
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
    setCacheStoreDockerBinForTests(dockerPath);
}

describe("system cache helpers", () => {
    let tempDir: string;
    let fetchCachedSystemHost: typeof import("./systemCache.js").fetchCachedSystemHost;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-system-cache-"));
        await installFakeDocker(tempDir);
        ({ fetchCachedSystemHost } = await import("./systemCache.js"));
    });

    beforeEach(() => {
        process.env.FAKE_SYSTEM_CACHE_MODE = "fresh";
    });

    after(async () => {
        process.env.PATH = originalPath;
        if (originalMode === undefined) {
            delete process.env.FAKE_SYSTEM_CACHE_MODE;
        } else {
            process.env.FAKE_SYSTEM_CACHE_MODE = originalMode;
        }
        setCacheStoreDockerBinForTests(undefined);
        await rm(tempDir, { recursive: true, force: true });
    });

    it("maps fresh system.host cache rows into API shape", async () => {
        const cached = await fetchCachedSystemHost();

        assert.equal(cached.source, "system");
        assert.equal(cached.status, "fresh");
        assert.equal(cached.updatedAt, "2026-05-11T00:00:00.000Z");
        assert.equal(cached.expiresAt, "2026-05-11T01:00:00.000Z");
        assert.equal(cached.errorCode, "WARN");
        assert.equal(cached.errorMessage, "Careful");
        assert.equal(cached.consecutiveFailures, 2);
        assert.deepEqual(cached.meta, { producer: "test" });
        assert.deepEqual(cached.data.version, {
            current: "v2026.5.4",
            latest: "v2026.5.5",
            updateAvailable: true,
            checkedAt: 1800000000000,
        });
        assert.equal(cached.data.doctorWarningCount, 2);
    });

    it("rejects missing, stale, and invalid system host cache rows", async () => {
        process.env.FAKE_SYSTEM_CACHE_MODE = "missing";
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache entry not found or not fresh",
        });

        process.env.FAKE_SYSTEM_CACHE_MODE = "stale";
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache entry not found or not fresh",
        });

        process.env.FAKE_SYSTEM_CACHE_MODE = "invalid";
        await assert.rejects(fetchCachedSystemHost, {
            message: "System host cache payload is invalid",
        });
    });
});
