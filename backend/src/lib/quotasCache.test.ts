import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";

import { setCacheStoreDockerBinForTests } from "./cacheStore.js";

const originalPath = process.env.PATH;
const originalMode = process.env.FAKE_QUOTAS_CACHE_MODE;

async function installFakeDocker(tempDir: string): Promise<void> {
    const binDir = path.join(tempDir, "bin");
    await mkdir(binDir, { recursive: true });
    const dockerPath = path.join(binDir, "docker");
    await writeFile(
        dockerPath,
        String.raw`#!${process.execPath}
const mode = process.env.FAKE_QUOTAS_CACHE_MODE || "fresh";
if (mode === "missing") {
  process.exit(0);
}
const status = mode === "stale" ? "stale" : "fresh";
const data = mode === "invalid" ? "not-json" : JSON.stringify({
  openrouter: { usage: 4, totalCredits: 10, remaining: 6, usageMonthly: 4, percentUsed: 40 },
  elevenlabs: { used: 100, total: 1000, remaining: 900, tier: "creator", percentUsed: 10, resetAt: "2026-06-01T00:00:00.000Z" },
  zai: { status: "not_configured" },
  synthetic: { status: "error", note: "offline" },
  openai: { account: "raymond", model: "gpt-5.5", fiveHourLeftPercent: 80, weeklyLeftPercent: 90, fiveHourReset: null, weeklyReset: null, percentUsed: 20, resetAt: null },
  checkedAt: 1800000000000,
  cacheAgeMs: 999,
});
process.stdout.write([
  "key\tdata\tsource\tupdated_at\tlast_attempt_at\texpires_at\tstatus\terror_code\terror_message\tconsecutive_failures\tmeta",
  "quotas.summary\t" + data + "\tquotas\t2026-05-11T00:00:00.000Z\t2026-05-11T00:00:00.000Z\t2026-05-11T01:00:00.000Z\t" + status + "\t\t\t0\t{}",
  "",
].join("\n"));
`,
        "utf8"
    );
    await chmod(dockerPath, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${originalPath || ""}`;
    setCacheStoreDockerBinForTests(dockerPath);
}

describe("quota cache helpers", () => {
    let tempDir: string;
    let fetchCachedQuotas: typeof import("./quotasCache.js").fetchCachedQuotas;
    let hasQuotaStatus: typeof import("./quotasCache.js").hasQuotaStatus;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-quotas-cache-"));
        await installFakeDocker(tempDir);
        ({ fetchCachedQuotas, hasQuotaStatus } = await import("./quotasCache.js"));
    });

    beforeEach(() => {
        process.env.FAKE_QUOTAS_CACHE_MODE = "fresh";
    });

    after(async () => {
        process.env.PATH = originalPath;
        if (originalMode === undefined) {
            delete process.env.FAKE_QUOTAS_CACHE_MODE;
        } else {
            process.env.FAKE_QUOTAS_CACHE_MODE = originalMode;
        }
        setCacheStoreDockerBinForTests(undefined);
        await rm(tempDir, { recursive: true, force: true });
    });

    it("maps fresh quota summary cache rows and recomputes cache age", async () => {
        const quotas = await fetchCachedQuotas();

        assert.deepEqual(quotas.openrouter, {
            usage: 4,
            totalCredits: 10,
            remaining: 6,
            usageMonthly: 4,
            percentUsed: 40,
        });
        assert.deepEqual(quotas.elevenlabs, {
            used: 100,
            total: 1000,
            remaining: 900,
            tier: "creator",
            percentUsed: 10,
            resetAt: "2026-06-01T00:00:00.000Z",
        });
        assert.equal(hasQuotaStatus(quotas.zai), true);
        assert.equal(hasQuotaStatus(quotas.synthetic), true);
        assert.equal(hasQuotaStatus(quotas.openrouter), false);
        assert.equal(quotas.cacheAgeMs, 0);
    });

    it("rejects missing, stale, and invalid quota cache rows", async () => {
        process.env.FAKE_QUOTAS_CACHE_MODE = "missing";
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache entry not found or not fresh",
        });

        process.env.FAKE_QUOTAS_CACHE_MODE = "stale";
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache entry not found or not fresh",
        });

        process.env.FAKE_QUOTAS_CACHE_MODE = "invalid";
        await assert.rejects(fetchCachedQuotas, {
            message: "Quota cache payload is invalid",
        });
    });
});
