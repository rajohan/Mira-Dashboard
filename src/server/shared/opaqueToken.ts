import * as v from "valibot";

import { areSha256DigestsEqual, randomHex, sha256Hex } from "./crypto.ts";

const opaqueTokenPrefixHexLength = 32;
const opaqueTokenValidatorHexLength = 64;
const opaqueTokenPattern = /^[0-9a-f]{32}\.[0-9a-f]{64}$/u;

const opaqueTokenSchema = v.pipe(
    v.string("Opaque token is invalid"),
    v.length(
        opaqueTokenPrefixHexLength + 1 + opaqueTokenValidatorHexLength,
        "Opaque token is invalid"
    ),
    v.regex(opaqueTokenPattern, "Opaque token is invalid")
);

/** Current persisted opaque-validator hashing format. */
export const opaqueTokenValidatorVersion = 1;

/** Prevents a validator from being replayed across independent trust domains. */
export type OpaqueTokenDomain = "automation" | "session";

function validatorHash(
    domain: OpaqueTokenDomain,
    prefix: string,
    validator: string
): string {
    return sha256Hex(
        `mira-dashboard:${domain}:v${opaqueTokenValidatorVersion}:${prefix}:${validator}`
    );
}

/** Non-secret lookup prefix and hashed secret derived from a valid opaque token. */
export interface ParsedOpaqueToken {
    readonly prefix: string;
    readonly validatorHash: string;
}

/** Newly generated token material. The complete token must be exposed only once. */
export interface GeneratedOpaqueToken extends ParsedOpaqueToken {
    readonly token: string;
    readonly validatorVersion: typeof opaqueTokenValidatorVersion;
}

/**
 * Generates independent 128-bit lookup and 256-bit validator components.
 * @param domain Trust domain bound into the validator hash.
 * @returns Complete one-time token plus its persistable non-secret material.
 */
export function generateOpaqueToken(domain: OpaqueTokenDomain): GeneratedOpaqueToken {
    const prefix = randomHex(opaqueTokenPrefixHexLength / 2);
    const validator = randomHex(opaqueTokenValidatorHexLength / 2);
    return Object.freeze({
        prefix,
        token: `${prefix}.${validator}`,
        validatorHash: validatorHash(domain, prefix, validator),
        validatorVersion: opaqueTokenValidatorVersion,
    });
}

/**
 * Validates an untrusted opaque token and hashes its validator component.
 * @param value Candidate cookie or bearer-token value.
 * @param domain Trust domain bound into the validator hash.
 * @returns Persistable lookup material, or undefined for malformed input.
 */
export function parseOpaqueToken(
    value: unknown,
    domain: OpaqueTokenDomain
): ParsedOpaqueToken | undefined {
    const parsed = v.safeParse(opaqueTokenSchema, value, { abortEarly: true });
    if (!parsed.success) return undefined;

    const prefix = parsed.output.slice(0, opaqueTokenPrefixHexLength);
    const validator = parsed.output.slice(opaqueTokenPrefixHexLength + 1);
    return Object.freeze({
        prefix,
        validatorHash: validatorHash(domain, prefix, validator),
    });
}

/**
 * Verifies a parsed token against one canonical persisted validator hash.
 * @param parsed Candidate token lookup material.
 * @param storedValidatorHash Persisted lowercase SHA-256 digest.
 * @returns Whether the candidate validator matches the stored digest.
 */
export function verifyOpaqueToken(
    parsed: ParsedOpaqueToken,
    storedValidatorHash: string
): boolean {
    return areSha256DigestsEqual(storedValidatorHash, parsed.validatorHash);
}
