import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { loadOrCreateDeviceIdentity } from "./openclawGatewayClient.js";

describe("OpenClaw gateway client identity", () => {
    let tempDir: string;
    let identityPath: string;

    before(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "mira-openclaw-identity-"));
        identityPath = path.join(tempDir, ".openclaw", "identity", "device.json");
    });

    after(async () => {
        await rm(tempDir, { recursive: true, force: true });
    });

    it("creates a durable v1 Ed25519 device identity", async () => {
        const identity = loadOrCreateDeviceIdentity(identityPath);
        const saved = JSON.parse(await readFile(identityPath, "utf8")) as Record<
            string,
            unknown
        >;

        assert.equal(saved.version, 1);
        assert.equal(saved.deviceId, identity.deviceId);
        assert.match(identity.deviceId, /^[a-f0-9]{64}$/u);
        assert.match(identity.publicKeyPem, /BEGIN PUBLIC KEY/u);
        assert.match(identity.privateKeyPem, /BEGIN PRIVATE KEY/u);
    });

    it("reloads existing identities and repairs mismatched device ids", async () => {
        const original = loadOrCreateDeviceIdentity(identityPath);
        await writeFile(
            identityPath,
            `${JSON.stringify({ version: 1, ...original, deviceId: "stale" }, null, 2)}\n`,
            "utf8"
        );

        const repaired = loadOrCreateDeviceIdentity(identityPath);
        const saved = JSON.parse(await readFile(identityPath, "utf8")) as Record<
            string,
            unknown
        >;

        assert.equal(repaired.deviceId, original.deviceId);
        assert.equal(saved.deviceId, original.deviceId);
        assert.equal(repaired.publicKeyPem, original.publicKeyPem);
        assert.equal(repaired.privateKeyPem, original.privateKeyPem);
    });

    it("replaces malformed identity files", async () => {
        await writeFile(identityPath, JSON.stringify({ version: 1, deviceId: "broken" }));

        const identity = loadOrCreateDeviceIdentity(identityPath);

        assert.match(identity.deviceId, /^[a-f0-9]{64}$/u);
        assert.notEqual(identity.deviceId, "broken");
    });
});
