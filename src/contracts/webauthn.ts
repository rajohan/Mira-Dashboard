import * as v from "valibot";

import { hasUniqueArrayItems } from "../shared/validation.ts";

export const webAuthnCredentialIdMinimumLength = 8;
export const webAuthnCredentialIdMaximumLength = 1024;
export const webAuthnChallengeMaximumLength = 256;
export const webAuthnClientDataMaximumLength = 4096;
export const webAuthnAttestationObjectMaximumLength = 8192;
export const webAuthnAuthenticatorDataMaximumLength = 4096;
export const webAuthnSignatureMaximumLength = 4096;
export const webAuthnUserHandleMaximumLength = 1024;
export const webAuthnPublicKeyMaximumLength = 2048;
export const webAuthnCeremonyTimeoutMs = 60_000;
export const webAuthnSupportedAlgorithm = -7 as const;

export const webAuthnTransports = [
    "ble",
    "cable",
    "hybrid",
    "internal",
    "nfc",
    "smart-card",
    "usb",
] as const;

export type WebAuthnTransport = (typeof webAuthnTransports)[number];

const webAuthnBase64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const webAuthnRpIdPattern =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/u;

export const webAuthnRpIdSchema = v.pipe(
    v.string("WebAuthn RP ID is invalid"),
    v.minLength(1, "WebAuthn RP ID is invalid"),
    v.maxLength(253, "WebAuthn RP ID is invalid"),
    v.regex(webAuthnRpIdPattern, "WebAuthn RP ID is invalid")
);

const webAuthnBase64UrlAlphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/**
 * Rejects padded, impossible-length, and non-zero trailing-bit encodings.
 * @param value Candidate unpadded base64url text.
 * @returns Whether the text is one canonical encoding.
 */
export function isCanonicalWebAuthnBase64Url(value: string): boolean {
    const remainder = value.length % 4;
    if (remainder === 1) return false;
    if (remainder === 0) return true;

    const lastCharacter = value.at(-1);
    if (lastCharacter === undefined) return false;
    const lastValue = webAuthnBase64UrlAlphabet.indexOf(lastCharacter);
    return (
        lastValue !== -1 && (remainder === 2 ? lastValue % 16 === 0 : lastValue % 4 === 0)
    );
}

function boundedBase64UrlSchema(
    label: string,
    minimumLength: number,
    maximumLength: number
) {
    return v.pipe(
        v.string(`${label} is invalid`),
        v.minLength(minimumLength, `${label} is invalid`),
        v.maxLength(maximumLength, `${label} is invalid`),
        v.regex(webAuthnBase64UrlPattern, `${label} is invalid`),
        v.check(isCanonicalWebAuthnBase64Url, `${label} is invalid`)
    );
}

export const webAuthnCredentialIdSchema = boundedBase64UrlSchema(
    "WebAuthn credential id",
    webAuthnCredentialIdMinimumLength,
    webAuthnCredentialIdMaximumLength
);

export const webAuthnChallengeSchema = boundedBase64UrlSchema(
    "WebAuthn challenge",
    32,
    webAuthnChallengeMaximumLength
);

export const webAuthnTransportSchema = v.picklist(
    webAuthnTransports,
    "WebAuthn transport is invalid"
);

/**
 * Canonicalizes validated transports for stable persistence and contract output.
 * @param transports Validated unique WebAuthn transports.
 * @returns A new list in canonical contract order.
 */
export function sortWebAuthnTransports(
    transports: WebAuthnTransport[]
): WebAuthnTransport[] {
    return transports.toSorted();
}

export const webAuthnTransportListSchema = v.pipe(
    v.array(webAuthnTransportSchema, "WebAuthn transports are invalid"),
    v.maxLength(webAuthnTransports.length, "WebAuthn transports are invalid"),
    v.check(hasUniqueArrayItems<WebAuthnTransport>, "WebAuthn transports must be unique"),
    v.transform(sortWebAuthnTransports)
);

const webAuthnClientDataSchema = boundedBase64UrlSchema(
    "WebAuthn client data",
    1,
    webAuthnClientDataMaximumLength
);
const webAuthnAttestationObjectSchema = boundedBase64UrlSchema(
    "WebAuthn attestation object",
    1,
    webAuthnAttestationObjectMaximumLength
);
const webAuthnAuthenticatorDataSchema = boundedBase64UrlSchema(
    "WebAuthn authenticator data",
    1,
    webAuthnAuthenticatorDataMaximumLength
);
const webAuthnSignatureSchema = boundedBase64UrlSchema(
    "WebAuthn signature",
    1,
    webAuthnSignatureMaximumLength
);
const webAuthnUserHandleSchema = boundedBase64UrlSchema(
    "WebAuthn user handle",
    1,
    webAuthnUserHandleMaximumLength
);
const webAuthnPublicKeySchema = boundedBase64UrlSchema(
    "WebAuthn public key",
    1,
    webAuthnPublicKeyMaximumLength * 2
);

const webAuthnAuthenticationExtensionResultsSchema = v.strictObject({});
const webAuthnCredentialPropertiesExtensionSchema = v.strictObject({
    rk: v.boolean(),
});
const webAuthnRegistrationExtensionResultsSchema = v.strictObject({
    credProps: v.optional(webAuthnCredentialPropertiesExtensionSchema),
});
const webAuthnAuthenticatorAttachmentSchema = v.picklist(["cross-platform", "platform"]);
const optionalWebAuthnSupportedAlgorithmSchema = v.optional(
    v.literal(webAuthnSupportedAlgorithm)
);

const webAuthnRegistrationResponseObjectSchema = v.strictObject({
    authenticatorAttachment: v.optional(webAuthnAuthenticatorAttachmentSchema),
    clientExtensionResults: webAuthnRegistrationExtensionResultsSchema,
    id: webAuthnCredentialIdSchema,
    rawId: webAuthnCredentialIdSchema,
    response: v.strictObject({
        attestationObject: webAuthnAttestationObjectSchema,
        authenticatorData: v.optional(webAuthnAuthenticatorDataSchema),
        clientDataJSON: webAuthnClientDataSchema,
        publicKey: v.optional(webAuthnPublicKeySchema),
        publicKeyAlgorithm: optionalWebAuthnSupportedAlgorithmSchema,
        transports: v.optional(webAuthnTransportListSchema),
    }),
    type: v.literal("public-key"),
});

const webAuthnAuthenticationResponseObjectSchema = v.strictObject({
    authenticatorAttachment: v.optional(webAuthnAuthenticatorAttachmentSchema),
    clientExtensionResults: webAuthnAuthenticationExtensionResultsSchema,
    id: webAuthnCredentialIdSchema,
    rawId: webAuthnCredentialIdSchema,
    response: v.strictObject({
        authenticatorData: webAuthnAuthenticatorDataSchema,
        clientDataJSON: webAuthnClientDataSchema,
        signature: webAuthnSignatureSchema,
        userHandle: v.optional(webAuthnUserHandleSchema),
    }),
    type: v.literal("public-key"),
});

/**
 * Runtime-only cross-field invariant not representable by draft JSON Schema.
 * @param value Strict registration response candidate.
 * @returns Whether browser credential identifiers match exactly.
 */
export function hasMatchingWebAuthnRegistrationCredentialIds(
    value: v.InferOutput<typeof webAuthnRegistrationResponseObjectSchema>
): boolean {
    return value.id === value.rawId;
}

/**
 * Runtime-only cross-field invariant not representable by draft JSON Schema.
 * @param value Strict authentication response candidate.
 * @returns Whether browser credential identifiers match exactly.
 */
export function hasMatchingWebAuthnAuthenticationCredentialIds(
    value: v.InferOutput<typeof webAuthnAuthenticationResponseObjectSchema>
): boolean {
    return value.id === value.rawId;
}

export const webAuthnRegistrationResponseSchema = v.pipe(
    webAuthnRegistrationResponseObjectSchema,
    v.check(
        hasMatchingWebAuthnRegistrationCredentialIds,
        "WebAuthn credential id and raw id must match"
    )
);

export const webAuthnAuthenticationResponseSchema = v.pipe(
    webAuthnAuthenticationResponseObjectSchema,
    v.check(
        hasMatchingWebAuthnAuthenticationCredentialIds,
        "WebAuthn credential id and raw id must match"
    )
);

const webAuthnCredentialDescriptorSchema = v.strictObject({
    id: webAuthnCredentialIdSchema,
    transports: v.optional(webAuthnTransportListSchema),
    type: v.literal("public-key"),
});

const webAuthnRelyingPartySchema = v.strictObject({
    id: webAuthnRpIdSchema,
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
});

const webAuthnUserSchema = v.strictObject({
    displayName: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    id: boundedBase64UrlSchema("WebAuthn user handle", 16, 128),
    name: v.pipe(v.string(), v.minLength(1), v.maxLength(64)),
});
const webAuthnSecurityKeyHintSchema = v.strictTuple([v.literal("security-key")]);
const webAuthnCredentialParameterSchema = v.strictObject({
    alg: v.literal(webAuthnSupportedAlgorithm),
    type: v.literal("public-key"),
});

export const webAuthnRegistrationOptionsSchema = v.strictObject({
    attestation: v.literal("none"),
    authenticatorSelection: v.strictObject({
        authenticatorAttachment: v.literal("cross-platform"),
        requireResidentKey: v.literal(false),
        residentKey: v.literal("discouraged"),
        userVerification: v.literal("required"),
    }),
    challenge: webAuthnChallengeSchema,
    excludeCredentials: v.pipe(
        v.array(webAuthnCredentialDescriptorSchema),
        v.maxLength(4)
    ),
    extensions: v.strictObject({ credProps: v.literal(true) }),
    hints: v.optional(webAuthnSecurityKeyHintSchema),
    pubKeyCredParams: v.strictTuple([webAuthnCredentialParameterSchema]),
    rp: webAuthnRelyingPartySchema,
    timeout: v.literal(webAuthnCeremonyTimeoutMs),
    user: webAuthnUserSchema,
});

export const webAuthnAuthenticationOptionsSchema = v.strictObject({
    allowCredentials: v.pipe(
        v.array(webAuthnCredentialDescriptorSchema),
        v.minLength(1),
        v.maxLength(4)
    ),
    challenge: webAuthnChallengeSchema,
    rpId: webAuthnRpIdSchema,
    timeout: v.literal(webAuthnCeremonyTimeoutMs),
    userVerification: v.literal("required"),
});

export const webAuthnAuthenticationInputSchema = v.strictObject({
    response: webAuthnAuthenticationResponseSchema,
});

export type WebAuthnAuthenticationInput = v.InferOutput<
    typeof webAuthnAuthenticationInputSchema
>;
export type WebAuthnAuthenticationOptions = v.InferOutput<
    typeof webAuthnAuthenticationOptionsSchema
>;
export type WebAuthnAuthenticationResponse = v.InferOutput<
    typeof webAuthnAuthenticationResponseSchema
>;
export type WebAuthnRegistrationOptions = v.InferOutput<
    typeof webAuthnRegistrationOptionsSchema
>;
export type WebAuthnRegistrationResponse = v.InferOutput<
    typeof webAuthnRegistrationResponseSchema
>;
