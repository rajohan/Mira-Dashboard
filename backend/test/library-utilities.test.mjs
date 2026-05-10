import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parseJsonField, parseTable } from "../dist/lib/cacheStore.js";
import { loadOrCreateDeviceIdentity } from "../dist/lib/openclawGatewayClient.js";

test("cacheStore parseTable handles empty, complete, and sparse tabular output", () => {
    assert.deepEqual(parseTable(""), []);
    assert.deepEqual(parseTable("only-one-line"), []);

    assert.deepEqual(parseTable("name\tstatus\nalpha\tfresh\nbeta\t"), [
        { name: "alpha", status: "fresh" },
        { name: "beta", status: "" },
    ]);
});

test("cacheStore parseJsonField returns parsed values or null for invalid fields", () => {
    const nullValue = JSON.parse("null");

    assert.deepEqual(parseJsonField('{"ok":true}'), { ok: true });
    assert.equal(parseJsonField("not-json"), nullValue);
    assert.equal(parseJsonField(""), nullValue);
});

test("loadOrCreateDeviceIdentity creates, reloads, and normalizes device identity files", async () => {
    const temporaryRoot = await mkdtemp(path.join(tmpdir(), "mira-dashboard-identity-"));
    const identityPath = path.join(temporaryRoot, "identity", "device.json");

    try {
        const created = loadOrCreateDeviceIdentity(identityPath);
        assert.equal(typeof created.deviceId, "string");
        assert.match(created.publicKeyPem, /BEGIN PUBLIC KEY/u);
        assert.match(created.privateKeyPem, /BEGIN PRIVATE KEY/u);

        const persisted = JSON.parse(await readFile(identityPath, "utf8"));
        assert.equal(persisted.version, 1);
        assert.equal(persisted.deviceId, created.deviceId);

        await writeFile(
            identityPath,
            `${JSON.stringify({ ...persisted, deviceId: "stale-id" })}\n`,
            "utf8"
        );

        const reloaded = loadOrCreateDeviceIdentity(identityPath);
        assert.deepEqual(reloaded, created);

        const rewritten = JSON.parse(await readFile(identityPath, "utf8"));
        assert.equal(rewritten.deviceId, created.deviceId);
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
