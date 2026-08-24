import { createECDH, type webcrypto } from "node:crypto";

import type {
    WebAuthnAuthenticationResponse,
    WebAuthnRegistrationResponse,
} from "../../../../../../contracts/webauthn.ts";

const encoder = new TextEncoder();

export const ceremonyFixtureOrigin = "https://dashboard.example";
export const ceremonyFixtureRpId = "dashboard.example";

function concatenate(...parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
    const output = new Uint8Array(
        parts.reduce((total, part) => total + part.byteLength, 0)
    );
    let offset = 0;
    for (const part of parts) {
        output.set(part, offset);
        offset += part.byteLength;
    }
    return output;
}

function sha256(value: string | Uint8Array): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(new Bun.CryptoHasher("sha256").update(value).digest());
}

function base64Url(value: Uint8Array): string {
    return Buffer.from(value).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array<ArrayBuffer> {
    return Uint8Array.from(Buffer.from(value, "base64url"));
}

// This deliberately insecure test-only key is derived from public fixture text.
const fixturePrivateScalar = sha256(
    "mira-dashboard-public-webauthn-test-key-never-use-in-production-v1"
);
const fixtureKeyAgreement = createECDH("prime256v1");
fixtureKeyAgreement.setPrivateKey(fixturePrivateScalar);
const fixturePublicPoint = fixtureKeyAgreement.getPublicKey(undefined, "uncompressed");
const fixturePrivateKey: webcrypto.JsonWebKey & {
    readonly x: string;
    readonly y: string;
} = Object.freeze({
    crv: "P-256",
    d: base64Url(fixturePrivateScalar),
    ext: true,
    key_ops: ["sign"],
    kty: "EC",
    x: base64Url(fixturePublicPoint.subarray(1, 33)),
    y: base64Url(fixturePublicPoint.subarray(33, 65)),
});

function cborByteString(value: Uint8Array): Uint8Array<ArrayBuffer> {
    if (value.byteLength > 255) throw new RangeError("Fixture CBOR value is too large");
    const header =
        value.byteLength < 24
            ? Uint8Array.of(0x40 + value.byteLength)
            : Uint8Array.of(0x58, value.byteLength);
    return concatenate(header, value);
}

function cborText(value: string): Uint8Array<ArrayBuffer> {
    const bytes = encoder.encode(value);
    if (bytes.byteLength >= 24) throw new RangeError("Fixture CBOR text is too large");
    return concatenate(Uint8Array.of(0x60 + bytes.byteLength), bytes);
}

function uint32(value: number): Uint8Array<ArrayBuffer> {
    return Uint8Array.of(
        (value >>> 24) & 255,
        (value >>> 16) & 255,
        (value >>> 8) & 255,
        value & 255
    );
}

const credentialIdBytes = sha256("mira-dashboard-webauthn-fixture-credential-v1");
const xCoordinate = decodeBase64Url(fixturePrivateKey.x);
const yCoordinate = decodeBase64Url(fixturePrivateKey.y);
const cosePublicKey = concatenate(
    Uint8Array.of(165, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21),
    cborByteString(xCoordinate),
    Uint8Array.of(0x22),
    cborByteString(yCoordinate)
);

export const ceremonyFixtureChallenge = base64Url(
    sha256("mira-dashboard-webauthn-fixture-challenge-v1")
);
export const ceremonyFixtureCredentialId = base64Url(credentialIdBytes);
export const ceremonyFixturePublicKey = cosePublicKey;

function registrationAuthenticatorData(): Uint8Array<ArrayBuffer> {
    return concatenate(
        sha256(ceremonyFixtureRpId),
        // UP, UV, BE, BS, and AT model a backed-up multi-device credential.
        Uint8Array.of(93),
        uint32(0),
        new Uint8Array(16),
        Uint8Array.of(0, credentialIdBytes.byteLength),
        credentialIdBytes,
        cosePublicKey
    );
}

function attestationObject(format: "none" | "packed"): string {
    const encoded = concatenate(
        Uint8Array.of(163),
        cborText("fmt"),
        cborText(format),
        cborText("attStmt"),
        Uint8Array.of(160),
        cborText("authData"),
        cborByteString(registrationAuthenticatorData())
    );
    return base64Url(encoded);
}

function clientData(input: {
    readonly challenge?: string;
    readonly crossOrigin: boolean;
    readonly origin: string;
    readonly type: "webauthn.create" | "webauthn.get";
}): Uint8Array<ArrayBuffer> {
    return encoder.encode(
        JSON.stringify({
            challenge: input.challenge ?? ceremonyFixtureChallenge,
            crossOrigin: input.crossOrigin,
            origin: input.origin,
            type: input.type,
        })
    );
}

export interface RegistrationFixtureOptions {
    readonly challenge?: string;
    readonly crossOrigin?: boolean;
    readonly format?: "none" | "packed";
    readonly origin?: string;
    readonly rawId?: string;
}

/**
 * Builds a stable real ES256 registration response with an authenticator-data public key.
 * @returns Registration fixture accepted by the strict public contract.
 */
export function createRegistrationFixture(
    options: RegistrationFixtureOptions = {}
): WebAuthnRegistrationResponse {
    return {
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: { credProps: { rk: false } },
        id: ceremonyFixtureCredentialId,
        rawId: options.rawId ?? ceremonyFixtureCredentialId,
        response: {
            attestationObject: attestationObject(options.format ?? "none"),
            clientDataJSON: base64Url(
                clientData({
                    ...(options.challenge === undefined
                        ? {}
                        : { challenge: options.challenge }),
                    crossOrigin: options.crossOrigin ?? false,
                    origin: options.origin ?? ceremonyFixtureOrigin,
                    type: "webauthn.create",
                })
            ),
            transports: ["usb"],
        },
        type: "public-key",
    };
}

function derInteger(value: Uint8Array): Uint8Array<ArrayBuffer> {
    let firstNonZero = 0;
    while (firstNonZero < value.byteLength - 1 && value[firstNonZero] === 0) {
        firstNonZero += 1;
    }
    const trimmed = value.subarray(firstNonZero);
    const bytes =
        (trimmed[0] ?? 0) >= 0x80
            ? concatenate(Uint8Array.of(0), trimmed)
            : Uint8Array.from(trimmed);
    return concatenate(Uint8Array.of(0x02, bytes.byteLength), bytes);
}

function derEcdsaSignature(rawSignature: Uint8Array): Uint8Array<ArrayBuffer> {
    if (rawSignature.byteLength !== 64) {
        throw new RangeError("Fixture ECDSA signature has an unexpected size");
    }
    const r = derInteger(rawSignature.subarray(0, 32));
    const s = derInteger(rawSignature.subarray(32));
    return concatenate(Uint8Array.of(0x30, r.byteLength + s.byteLength), r, s);
}

export interface AuthenticationFixtureOptions {
    readonly challenge?: string;
    readonly counter: number;
    readonly crossOrigin?: boolean;
    readonly id?: string;
    readonly origin?: string;
    readonly rawId?: string;
    readonly userHandle?: string;
}

/**
 * Builds and signs a real ES256 assertion for monotonic and zero-counter fixtures.
 * @returns Signed assertion fixture accepted by the strict public contract.
 */
export async function createAuthenticationFixture(
    options: AuthenticationFixtureOptions
): Promise<WebAuthnAuthenticationResponse> {
    const encodedClientData = clientData({
        ...(options.challenge === undefined ? {} : { challenge: options.challenge }),
        crossOrigin: options.crossOrigin ?? false,
        origin: options.origin ?? ceremonyFixtureOrigin,
        type: "webauthn.get",
    });
    const authenticatorData = concatenate(
        sha256(ceremonyFixtureRpId),
        // UP, UV, BE, and BS model the registered multi-device credential.
        Uint8Array.of(29),
        uint32(options.counter)
    );
    const signedData = concatenate(authenticatorData, sha256(encodedClientData));
    const privateKey = await crypto.subtle.importKey(
        "jwk",
        fixturePrivateKey,
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"]
    );
    const rawSignature = new Uint8Array(
        await crypto.subtle.sign(
            { hash: "SHA-256", name: "ECDSA" },
            privateKey,
            signedData
        )
    );
    const id = options.id ?? ceremonyFixtureCredentialId;
    return {
        authenticatorAttachment: "cross-platform",
        clientExtensionResults: {},
        id,
        rawId: options.rawId ?? id,
        response: {
            authenticatorData: base64Url(authenticatorData),
            clientDataJSON: base64Url(encodedClientData),
            signature: base64Url(derEcdsaSignature(rawSignature)),
            ...(options.userHandle === undefined
                ? {}
                : { userHandle: options.userHandle }),
        },
        type: "public-key",
    };
}
