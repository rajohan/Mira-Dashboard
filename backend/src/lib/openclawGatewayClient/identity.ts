import {
    createPrivateKey,
    createPublicKey,
    generateKeyPairSync,
    sign,
} from "node:crypto";
import fs from "node:fs";
import Path from "node:path";

import type { DeviceIdentity } from "./types.ts";

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Performs base64 URL encode.
 * @returns Base64 URL encode result.
 */
function base64UrlEncode(buffer: Buffer): string {
    const bytes = buffer as unknown as Uint8Array & { toBase64: () => string };
    return bytes.toBase64().replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}
/**
 * Performs derive public key raw.
 * @param publicKeyPem Public key pem value.
 * @returns Derive public key raw result.
 */
function derivePublicKeyRaw(publicKeyPem: string): Buffer {
    const spki = createPublicKey(publicKeyPem).export({
        type: "spki",
        format: "der",
    });

    if (
        spki.length === ED25519_SPKI_PREFIX.length + 32 &&
        spki.subarray(0, ED25519_SPKI_PREFIX.length).equals(ED25519_SPKI_PREFIX)
    ) {
        return spki.subarray(ED25519_SPKI_PREFIX.length);
    }
    return spki;
}

/**
 * Performs fingerprint public key.
 * @param publicKeyPem Public key pem value.
 * @returns Fingerprint public key result.
 */
function fingerprintPublicKey(publicKeyPem: string): string {
    return new Bun.CryptoHasher("sha256")
        .update(derivePublicKeyRaw(publicKeyPem))
        .digest("hex");
}

/**
 * Performs public key raw base64 URL from pem.
 * @param publicKeyPem Public key pem value.
 * @returns Public key raw base64 URL from pem result.
 */
export function publicKeyRawBase64UrlFromPem(publicKeyPem: string): string {
    return base64UrlEncode(derivePublicKeyRaw(publicKeyPem));
}
/**
 * Performs sign device payload.
 * @param privateKeyPem Private key pem value.
 * @param payload Request or event payload.
 * @returns Sign device payload result.
 */
export function signDevicePayload(privateKeyPem: string, payload: string): string {
    const key = createPrivateKey(privateKeyPem);
    return base64UrlEncode(sign(undefined, Buffer.from(payload, "utf8"), key));
}

/**
 * Performs generate IDentity.
 * @returns Generate IDentity result.
 */
function generateIdentity(): DeviceIdentity {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

    return {
        deviceId: fingerprintPublicKey(publicKeyPem),
        publicKeyPem,
        privateKeyPem,
    };
}

/**
 * Performs load or create device IDentity.
 * @param filePath File path value.
 * @returns Load or create device IDentity result.
 */
export function loadOrCreateDeviceIdentity(filePath: string): DeviceIdentity {
    fs.mkdirSync(Path.dirname(filePath), { recursive: true });

    try {
        const parsed = JSON.parse(
            fs.readFileSync(filePath, "utf8")
        ) as Partial<DeviceIdentity> & {
            version?: number;
        };

        if (
            parsed?.version === 1 &&
            typeof parsed.deviceId === "string" &&
            typeof parsed.publicKeyPem === "string" &&
            typeof parsed.privateKeyPem === "string"
        ) {
            const identity: DeviceIdentity = {
                deviceId: fingerprintPublicKey(parsed.publicKeyPem),
                publicKeyPem: parsed.publicKeyPem,
                privateKeyPem: parsed.privateKeyPem,
            };

            fs.writeFileSync(
                filePath,
                `${JSON.stringify({ version: 1, ...identity }, undefined, 2)}\n`,
                { mode: 0o600 }
            );

            return identity;
        }
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && !(error instanceof SyntaxError)) {
            throw error;
        }
        // Missing or invalid JSON identity file; generate new identity below.
    }

    const identity = generateIdentity();
    fs.writeFileSync(
        filePath,
        `${JSON.stringify({ version: 1, ...identity }, undefined, 2)}\n`,
        {
            mode: 0o600,
        }
    );
    return identity;
}

/**
 * Normalizes device metadata for auth.
 * @param value Value to process.
 * @returns Normalized device metadata for auth.
 */
function normalizeDeviceMetadataForAuth(value?: string): string {
    if (typeof value !== "string") {
        return "";
    }

    const trimmed = value.trim();
    return trimmed ? trimmed.replaceAll(/[A-Z]/gu, (char) => char.toLowerCase()) : "";
}

/**
 * Builds device auth payload v3.
 * @param parameters Parameters value.
 * @returns Built device auth payload v3.
 */
export function buildDeviceAuthPayloadV3(parameters: {
    deviceId: string;
    clientId: string;
    clientMode: string;
    role: string;
    scopes: string[];
    signedAtMs: number;
    token?: string | undefined;
    nonce: string;
    platform?: string;
    deviceFamily?: string;
}): string {
    return [
        "v3",
        parameters.deviceId,
        parameters.clientId,
        parameters.clientMode,
        parameters.role,
        parameters.scopes.join(","),
        String(parameters.signedAtMs),
        parameters.token ?? "",
        parameters.nonce,
        normalizeDeviceMetadataForAuth(parameters.platform),
        normalizeDeviceMetadataForAuth(parameters.deviceFamily),
    ].join("|");
}
