import type {
    AuthenticatorTransportFuture,
    Base64URLString,
} from "@simplewebauthn/server";
import {
    decodeAttestationObject,
    decodeClientDataJSON,
} from "@simplewebauthn/server/helpers";
import * as v from "valibot";

import {
    webAuthnAttestationObjectMaximumLength,
    webAuthnClientDataMaximumLength,
    webAuthnCredentialIdSchema,
    webAuthnPublicKeyMaximumLength,
    webAuthnSupportedAlgorithm,
    webAuthnTransportListSchema,
    type WebAuthnTransport,
} from "../../../../../contracts/webauthn.ts";

const canonicalBase64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const uint32Maximum = 4_294_967_295;
const webAuthnCredentialMaximumCount = 4;
const unsafeHumanTextPattern = /[\p{Cc}\p{Cf}]/u;

export const webAuthnUserHandleByteLength = 32;

export interface WebAuthnBoundaryCredentialDescriptor {
    readonly id: string;
    readonly transports?: readonly WebAuthnTransport[];
}

export interface WebAuthnBoundaryStoredCredential extends WebAuthnBoundaryCredentialDescriptor {
    readonly algorithm: typeof webAuthnSupportedAlgorithm;
    readonly counter: number;
    readonly publicKey: Uint8Array;
}

export interface WebAuthnBoundaryDecodeDependencies {
    readonly decodeAttestationObject: typeof decodeAttestationObject;
    readonly decodeClientDataJSON: typeof decodeClientDataJSON;
}

/**
 * Decodes one canonical unpadded base64url value only within the declared byte budget.
 * @param value Untrusted encoded value.
 * @param maximumByteLength Maximum decoded byte count.
 * @returns A fresh byte array, or undefined when encoding or bounds are invalid.
 */
export function canonicalBase64UrlBytes(
    value: unknown,
    maximumByteLength: number
): Uint8Array<ArrayBuffer> | undefined {
    if (
        typeof value !== "string" ||
        value.length === 0 ||
        value.length > Math.ceil((maximumByteLength * 4) / 3) ||
        !canonicalBase64UrlPattern.test(value)
    ) {
        return undefined;
    }
    const bytes = Buffer.from(value, "base64url");
    if (bytes.byteLength > maximumByteLength || bytes.toString("base64url") !== value) {
        return undefined;
    }
    return Uint8Array.from(bytes);
}

/**
 * Checks bounded non-blank human text without Unicode control or format characters.
 * @param value Untrusted human-readable value.
 * @param maximumLength Maximum UTF-16 code-unit count.
 * @returns Whether the value is safe at the WebAuthn adapter boundary.
 */
export function hasSafeHumanText(value: unknown, maximumLength: number): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= maximumLength &&
        value.trim() === value &&
        !unsafeHumanTextPattern.test(value)
    );
}

/**
 * Validates, deduplicates, and normalizes credential descriptors for SimpleWebAuthn.
 * @param value Candidate credential descriptors.
 * @param minimumLength Minimum required descriptor count for the ceremony.
 * @returns Normalized descriptors, or undefined when any descriptor is invalid.
 */
export function normalizedCredentialDescriptors(
    value: readonly WebAuthnBoundaryCredentialDescriptor[],
    minimumLength: number
): { id: Base64URLString; transports?: AuthenticatorTransportFuture[] }[] | undefined {
    if (value.length < minimumLength || value.length > webAuthnCredentialMaximumCount) {
        return undefined;
    }

    const credentialIds = new Set<string>();
    const descriptors: {
        id: Base64URLString;
        transports?: AuthenticatorTransportFuture[];
    }[] = [];
    for (const credential of value) {
        if (
            credentialIds.has(credential.id) ||
            !v.safeParse(webAuthnCredentialIdSchema, credential.id, {
                abortEarly: true,
            }).success
        ) {
            return undefined;
        }
        credentialIds.add(credential.id);

        const transports = credential.transports
            ? v.safeParse(webAuthnTransportListSchema, [...credential.transports], {
                  abortEarly: true,
              })
            : undefined;
        if (transports && !transports.success) return undefined;
        descriptors.push({
            id: credential.id,
            ...(transports ? { transports: [...transports.output] } : {}),
        });
    }
    return descriptors;
}

/**
 * Bounded-decodes client data with the public helper and rejects cross-origin ceremonies.
 * @param value Untrusted encoded client data.
 * @param dependencies Injectable public SimpleWebAuthn decoders.
 * @returns Whether the client data is bounded, decodable, and same-origin.
 */
export function preflightClientData(
    value: unknown,
    dependencies: WebAuthnBoundaryDecodeDependencies
): boolean {
    if (
        typeof value !== "string" ||
        canonicalBase64UrlBytes(value, webAuthnClientDataMaximumLength) === undefined
    ) {
        return false;
    }
    try {
        const clientData = dependencies.decodeClientDataJSON(value);
        return clientData.crossOrigin !== true;
    } catch {
        return false;
    }
}

/**
 * Bounded-decodes attestation data before any format verifier can fetch certificates.
 * @param value Untrusted encoded attestation object.
 * @param dependencies Injectable public SimpleWebAuthn decoders.
 * @returns Whether the attestation uses the required no-attestation format.
 */
export function preflightAttestation(
    value: unknown,
    dependencies: WebAuthnBoundaryDecodeDependencies
): boolean {
    const bytes = canonicalBase64UrlBytes(value, webAuthnAttestationObjectMaximumLength);
    if (!bytes) return false;
    try {
        return dependencies.decodeAttestationObject(bytes).get("fmt") === "none";
    } catch {
        return false;
    }
}

/**
 * Revalidates persisted credential material before passing it to cryptography.
 * @param credential Candidate persisted credential.
 * @returns Whether the credential is bounded and matches the fixed algorithm policy.
 */
export function hasValidCredentialState(
    credential: WebAuthnBoundaryStoredCredential
): boolean {
    const transports = credential.transports
        ? v.safeParse(webAuthnTransportListSchema, [...credential.transports], {
              abortEarly: true,
          })
        : undefined;
    return (
        credential.algorithm === webAuthnSupportedAlgorithm &&
        v.safeParse(webAuthnCredentialIdSchema, credential.id, {
            abortEarly: true,
        }).success &&
        hasValidCounter(credential.counter) &&
        credential.publicKey.byteLength > 0 &&
        credential.publicKey.byteLength <= webAuthnPublicKeyMaximumLength &&
        (!transports || transports.success)
    );
}

function hasValidCounter(value: number): boolean {
    return Number.isSafeInteger(value) && value >= 0 && value <= uint32Maximum;
}

/**
 * Checks the counter and backup-state invariants returned by cryptographic verification.
 * @param input Normalized SimpleWebAuthn verification metadata.
 * @returns Whether the metadata can safely cross into persistence.
 */
export function hasValidVerificationMetadata(input: {
    readonly backedUp: boolean;
    readonly counter: number;
    readonly deviceType: "multiDevice" | "singleDevice";
}): boolean {
    return (
        hasValidCounter(input.counter) &&
        !(input.deviceType === "singleDevice" && input.backedUp)
    );
}
