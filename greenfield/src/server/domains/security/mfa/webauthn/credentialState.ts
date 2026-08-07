import { getTime } from "date-fns";
import * as v from "valibot";

import type { WebAuthnCredentialSummary } from "../../../../../contracts/accountSecurity.ts";
import {
    webAuthnTransportListSchema,
    webAuthnTransports,
    type WebAuthnTransport,
} from "../../../../../contracts/webauthn.ts";
import {
    webAuthnTransportBitByName,
    webAuthnTransportBitmaskMaximum,
} from "../../../../database/schema/userWebAuthnCredentials.ts";
import type { MfaWebAuthnCredentialRecord } from "../lifecycleRepositoryTypes.ts";
import type {
    WebAuthnCredentialDescriptor,
    WebAuthnStoredCredential,
} from "./adapter.ts";

/**
 * Encodes the canonical transport list into the reviewed seven-bit DB representation.
 * @param input Validated transport names.
 * @returns Stable transport bit mask.
 */
export function webAuthnTransportMask(input: readonly WebAuthnTransport[]): number {
    const transports = v.parse(webAuthnTransportListSchema, [...input]);
    return transports.reduce(
        (mask, transport) => mask | webAuthnTransportBitByName[transport],
        0
    );
}

/**
 * Decodes a validated DB mask into the canonical contract order.
 * @param mask Persisted seven-bit transport mask.
 * @returns Frozen canonical transport names.
 */
export function webAuthnTransportsFromMask(mask: number): readonly WebAuthnTransport[] {
    if (
        !Number.isSafeInteger(mask) ||
        mask < 0 ||
        mask > webAuthnTransportBitmaskMaximum
    ) {
        throw new RangeError("WebAuthn transport mask is invalid");
    }
    return Object.freeze(
        webAuthnTransports.filter(
            (transport) => (mask & webAuthnTransportBitByName[transport]) !== 0
        )
    );
}

export function webAuthnCredentialDescriptor(
    credential: MfaWebAuthnCredentialRecord
): WebAuthnCredentialDescriptor {
    return Object.freeze({
        id: credential.credentialId,
        transports: [...webAuthnTransportsFromMask(credential.transportMask)],
    });
}

export function webAuthnCredentialSummary(
    credential: MfaWebAuthnCredentialRecord,
    activeRpId: string | undefined
): WebAuthnCredentialSummary {
    return Object.freeze({
        backedUp: credential.backedUp,
        createdAtMs: getTime(credential.createdAt),
        deviceType: credential.deviceType,
        id: credential.id,
        label: credential.label,
        ...(credential.lastUsedAt === null
            ? {}
            : { lastUsedAtMs: getTime(credential.lastUsedAt) }),
        transports: [...webAuthnTransportsFromMask(credential.transportMask)],
        usable: credential.rpId === activeRpId,
    });
}

export function webAuthnStoredCredential(
    credential: MfaWebAuthnCredentialRecord
): WebAuthnStoredCredential {
    return Object.freeze({
        ...webAuthnCredentialDescriptor(credential),
        algorithm: credential.algorithm,
        counter: credential.counter,
        deviceType: credential.deviceType,
        publicKey: Uint8Array.from(credential.publicKey),
        rpId: credential.rpId,
    });
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
    return (
        left.byteLength === right.byteLength &&
        left.every((value, index) => value === right[index])
    );
}

export function webAuthnCredentialSnapshotMatches(
    current: MfaWebAuthnCredentialRecord | undefined,
    expected: MfaWebAuthnCredentialRecord
): current is MfaWebAuthnCredentialRecord {
    return (
        current !== undefined &&
        current.id === expected.id &&
        current.userId === expected.userId &&
        current.credentialId === expected.credentialId &&
        current.algorithm === expected.algorithm &&
        current.counter === expected.counter &&
        current.transportMask === expected.transportMask &&
        current.deviceType === expected.deviceType &&
        current.backedUp === expected.backedUp &&
        current.label === expected.label &&
        current.rpId === expected.rpId &&
        getTime(current.createdAt) === getTime(expected.createdAt) &&
        (current.lastUsedAt === null
            ? expected.lastUsedAt === null
            : expected.lastUsedAt !== null &&
              getTime(current.lastUsedAt) === getTime(expected.lastUsedAt)) &&
        bytesEqual(current.publicKey, expected.publicKey)
    );
}
