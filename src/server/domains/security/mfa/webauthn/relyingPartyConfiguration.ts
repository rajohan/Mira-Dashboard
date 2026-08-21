import * as v from "valibot";

import { webAuthnRpIdSchema } from "../../../../../contracts/webauthn.ts";
import { sha256Hex } from "../../../../shared/crypto.ts";

export const webAuthnAllowedOriginMaximumCount = 8;
export const webAuthnRelyingPartyNameMaximumLength = 128;

const relyingPartyConfigurationErrorMessage =
    "WebAuthn relying-party configuration is invalid";
const unsafeHumanTextPattern = /[\p{Cc}\p{Cf}]/u;

/** A composition-time WebAuthn configuration failure without echoing sensitive input. */
export class WebAuthnRelyingPartyConfigurationError extends Error {
    readonly _tag = "WebAuthnRelyingPartyConfigurationError";

    constructor() {
        super(relyingPartyConfigurationErrorMessage);
        this.name = "WebAuthnRelyingPartyConfigurationError";
    }
}

export interface WebAuthnRelyingPartyConfigurationInput {
    readonly allowedOrigins: readonly string[];
    readonly rpId: string;
    readonly rpName: string;
}

/** Fixed WebAuthn trust configuration. Request host headers never participate. */
export interface WebAuthnRelyingPartyConfiguration {
    readonly allowedOrigins: readonly string[];
    readonly fingerprint: string;
    readonly rpId: string;
    readonly rpName: string;
}

function invalidConfiguration(): never {
    throw new WebAuthnRelyingPartyConfigurationError();
}

function canonicalRelyingPartyName(value: unknown): string {
    if (typeof value !== "string") invalidConfiguration();
    const canonical = value.trim().normalize("NFC");
    if (
        canonical.length === 0 ||
        canonical.length > webAuthnRelyingPartyNameMaximumLength ||
        unsafeHumanTextPattern.test(canonical)
    ) {
        invalidConfiguration();
    }
    return canonical;
}

function isRelyingPartyHostname(hostname: string, rpId: string): boolean {
    if (rpId === "localhost") return hostname === rpId;
    return hostname === rpId || hostname.endsWith(`.${rpId}`);
}

function canonicalAllowedOrigin(value: unknown, rpId: string): string {
    if (typeof value !== "string") invalidConfiguration();

    let url: URL;
    try {
        url = new URL(value);
    } catch {
        invalidConfiguration();
    }

    const isLocalDevelopmentOrigin =
        rpId === "localhost" && url.hostname === "localhost" && url.protocol === "http:";
    if (
        url.origin !== value ||
        (url.protocol !== "https:" && !isLocalDevelopmentOrigin) ||
        !isRelyingPartyHostname(url.hostname, rpId)
    ) {
        invalidConfiguration();
    }
    return url.origin;
}

function configurationFingerprint(
    rpId: string,
    rpName: string,
    allowedOrigins: readonly string[]
): string {
    return sha256Hex(
        JSON.stringify({
            allowedOrigins,
            policy: "mira-dashboard-webauthn-rp-v1",
            rpId,
            rpName,
        })
    );
}

/**
 * Validates and freezes the exact RP identity and origin allowlist used by every ceremony.
 * @param input Explicit server composition values, never request-derived values.
 * @returns Canonical immutable configuration with a deterministic challenge-binding fingerprint.
 * @throws {WebAuthnRelyingPartyConfigurationError} When any value is unsafe or inconsistent.
 */
export function createWebAuthnRelyingPartyConfiguration(
    input: WebAuthnRelyingPartyConfigurationInput
): WebAuthnRelyingPartyConfiguration {
    const rpIdResult = v.safeParse(webAuthnRpIdSchema, input.rpId, {
        abortEarly: true,
    });
    if (!rpIdResult.success) invalidConfiguration();
    if (
        input.allowedOrigins.length === 0 ||
        input.allowedOrigins.length > webAuthnAllowedOriginMaximumCount
    ) {
        invalidConfiguration();
    }

    const rpId = rpIdResult.output;
    const rpName = canonicalRelyingPartyName(input.rpName);
    const allowedOrigins = input.allowedOrigins
        .map((origin) => canonicalAllowedOrigin(origin, rpId))
        .toSorted();
    if (new Set(allowedOrigins).size !== allowedOrigins.length) {
        invalidConfiguration();
    }

    Object.freeze(allowedOrigins);
    return Object.freeze({
        allowedOrigins,
        fingerprint: configurationFingerprint(rpId, rpName, allowedOrigins),
        rpId,
        rpName,
    });
}

/**
 * Derives the stable opaque 32-byte WebAuthn user handle from an internal user identifier.
 * @param userId Canonical internal user identifier, never a username or email address.
 * @returns Unpadded base64url SHA-256 user handle.
 */
export function createWebAuthnUserHandle(userId: string): string {
    if (
        userId.length === 0 ||
        userId.length > 1024 ||
        unsafeHumanTextPattern.test(userId)
    ) {
        throw new TypeError("WebAuthn user identity is invalid");
    }
    return Uint8Array.fromHex(
        sha256Hex(`mira-dashboard:webauthn-user-handle:v1:${userId}`)
    ).toBase64({ alphabet: "base64url", omitPadding: true });
}
