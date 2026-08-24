import {
    generateAuthenticationOptions as generateSimpleAuthenticationOptions,
    generateRegistrationOptions as generateSimpleRegistrationOptions,
    verifyAuthenticationResponse as verifySimpleAuthenticationResponse,
    verifyRegistrationResponse as verifySimpleRegistrationResponse,
    type COSEAlgorithmIdentifier,
    type RegistrationResponseJSON,
    type WebAuthnCredential,
} from "@simplewebauthn/server";
import {
    decodeAttestationObject as decodeSimpleAttestationObject,
    decodeClientDataJSON as decodeSimpleClientDataJSON,
} from "@simplewebauthn/server/helpers";
import * as v from "valibot";

import {
    webAuthnAuthenticationOptionsSchema,
    webAuthnAuthenticationResponseSchema,
    webAuthnCeremonyTimeoutMs,
    webAuthnChallengeSchema,
    webAuthnPublicKeyMaximumLength,
    webAuthnRegistrationOptionsSchema,
    webAuthnRegistrationResponseSchema,
    webAuthnSupportedAlgorithm,
    webAuthnTransportListSchema,
    type WebAuthnAuthenticationOptions,
    type WebAuthnAuthenticationResponse,
    type WebAuthnRegistrationOptions,
    type WebAuthnRegistrationResponse,
    type WebAuthnTransport,
} from "../../../../../contracts/webauthn.ts";
import {
    canonicalBase64UrlBytes,
    hasSafeHumanText,
    hasValidCredentialState,
    hasValidVerificationMetadata,
    normalizedCredentialDescriptors,
    preflightAttestation,
    preflightClientData,
    webAuthnUserHandleByteLength,
} from "./boundaryValidation.ts";
import type { WebAuthnRelyingPartyConfiguration } from "./relyingPartyConfiguration.ts";

const supportedAlgorithms: readonly COSEAlgorithmIdentifier[] = Object.freeze([
    webAuthnSupportedAlgorithm,
]);

export interface WebAuthnCredentialDescriptor {
    readonly id: string;
    readonly transports?: readonly WebAuthnTransport[];
}

export interface WebAuthnStoredCredential extends WebAuthnCredentialDescriptor {
    readonly algorithm: typeof webAuthnSupportedAlgorithm;
    readonly counter: number;
    readonly deviceType: "multiDevice" | "singleDevice";
    readonly publicKey: Uint8Array;
    readonly rpId: string;
}

export interface GenerateWebAuthnRegistrationOptionsInput {
    readonly excludeCredentials: readonly WebAuthnCredentialDescriptor[];
    readonly userDisplayName: string;
    readonly userHandle: string;
    readonly userName: string;
}

export interface GenerateWebAuthnAuthenticationOptionsInput {
    readonly allowCredentials: readonly WebAuthnCredentialDescriptor[];
}

export interface VerifyWebAuthnRegistrationInput {
    readonly expectedChallenge: string;
    readonly response: WebAuthnRegistrationResponse;
}

export interface VerifyWebAuthnAuthenticationInput {
    readonly credential: WebAuthnStoredCredential;
    readonly expectedChallenge: string;
    readonly expectedUserHandle?: string;
    readonly response: WebAuthnAuthenticationResponse;
}

export type WebAuthnOptionsGenerationResult<Options> =
    | { readonly options: Options; readonly status: "generated" }
    | { readonly status: "invalid-input" }
    | { readonly status: "unavailable" };

export interface VerifiedWebAuthnRegistration {
    readonly credential: {
        readonly algorithm: typeof webAuthnSupportedAlgorithm;
        readonly counter: number;
        readonly id: string;
        readonly publicKey: Uint8Array;
        readonly transports: readonly WebAuthnTransport[];
    };
    readonly credentialBackedUp: boolean;
    readonly credentialDeviceType: "multiDevice" | "singleDevice";
}

export interface VerifiedWebAuthnAuthentication {
    readonly credentialBackedUp: boolean;
    readonly credentialDeviceType: "multiDevice" | "singleDevice";
    readonly credentialId: string;
    readonly newCounter: number;
}

export type WebAuthnVerificationResult<Verification> =
    | { readonly status: "invalid-proof" }
    | { readonly status: "verified"; readonly verification: Verification };

/** Injectable boundary around the pinned SimpleWebAuthn implementation. */
export interface WebAuthnAdapter {
    generateAuthenticationOptions(
        input: GenerateWebAuthnAuthenticationOptionsInput
    ): Promise<WebAuthnOptionsGenerationResult<WebAuthnAuthenticationOptions>>;
    generateRegistrationOptions(
        input: GenerateWebAuthnRegistrationOptionsInput
    ): Promise<WebAuthnOptionsGenerationResult<WebAuthnRegistrationOptions>>;
    verifyAuthentication(
        input: VerifyWebAuthnAuthenticationInput
    ): Promise<WebAuthnVerificationResult<VerifiedWebAuthnAuthentication>>;
    verifyRegistration(
        input: VerifyWebAuthnRegistrationInput
    ): Promise<WebAuthnVerificationResult<VerifiedWebAuthnRegistration>>;
}

export interface WebAuthnAdapterDependencies {
    readonly decodeAttestationObject: typeof decodeSimpleAttestationObject;
    readonly decodeClientDataJSON: typeof decodeSimpleClientDataJSON;
    readonly generateAuthenticationOptions: typeof generateSimpleAuthenticationOptions;
    readonly generateRegistrationOptions: typeof generateSimpleRegistrationOptions;
    readonly verifyAuthenticationResponse: typeof verifySimpleAuthenticationResponse;
    readonly verifyRegistrationResponse: typeof verifySimpleRegistrationResponse;
}

const productionDependencies: WebAuthnAdapterDependencies = Object.freeze({
    decodeAttestationObject: decodeSimpleAttestationObject,
    decodeClientDataJSON: decodeSimpleClientDataJSON,
    generateAuthenticationOptions: generateSimpleAuthenticationOptions,
    generateRegistrationOptions: generateSimpleRegistrationOptions,
    verifyAuthenticationResponse: verifySimpleAuthenticationResponse,
    verifyRegistrationResponse: verifySimpleRegistrationResponse,
});

function asRegistrationResponse(
    response: WebAuthnRegistrationResponse
): RegistrationResponseJSON {
    return response;
}

/**
 * Creates one fixed-policy adapter. The caller owns cancellation and bounded execution via Effect.
 * @param configuration Exact RP identity and origin allowlist.
 * @param dependencyOverrides Injectable pinned library functions for focused boundary tests.
 * @returns Adapter that emits only normalized values or non-sensitive tagged failures.
 */
export function createWebAuthnAdapter(
    configuration: WebAuthnRelyingPartyConfiguration,
    dependencyOverrides: Partial<WebAuthnAdapterDependencies> = {}
): WebAuthnAdapter {
    const dependencies: WebAuthnAdapterDependencies = Object.freeze({
        ...productionDependencies,
        ...dependencyOverrides,
    });
    async function generateRegistration(
        input: GenerateWebAuthnRegistrationOptionsInput
    ): Promise<WebAuthnOptionsGenerationResult<WebAuthnRegistrationOptions>> {
        const excludeCredentials = normalizedCredentialDescriptors(
            input.excludeCredentials,
            0
        );
        const userHandle = canonicalBase64UrlBytes(
            input.userHandle,
            webAuthnUserHandleByteLength
        );
        if (
            !excludeCredentials ||
            userHandle?.byteLength !== webAuthnUserHandleByteLength ||
            !hasSafeHumanText(input.userName, 64) ||
            !hasSafeHumanText(input.userDisplayName, 128)
        ) {
            return { status: "invalid-input" };
        }

        try {
            const generated = await dependencies.generateRegistrationOptions({
                attestationType: "none",
                authenticatorSelection: {
                    authenticatorAttachment: "cross-platform",
                    residentKey: "discouraged",
                    userVerification: "required",
                },
                excludeCredentials,
                preferredAuthenticatorType: "securityKey",
                rpID: configuration.rpId,
                rpName: configuration.rpName,
                supportedAlgorithmIDs: [...supportedAlgorithms],
                timeout: webAuthnCeremonyTimeoutMs,
                userDisplayName: input.userDisplayName,
                userID: userHandle,
                userName: input.userName,
            });
            const parsed = v.safeParse(webAuthnRegistrationOptionsSchema, generated, {
                abortEarly: true,
            });
            return parsed.success
                ? { options: parsed.output, status: "generated" }
                : { status: "unavailable" };
        } catch {
            return { status: "unavailable" };
        }
    }

    async function generateAuthentication(
        input: GenerateWebAuthnAuthenticationOptionsInput
    ): Promise<WebAuthnOptionsGenerationResult<WebAuthnAuthenticationOptions>> {
        const allowCredentials = normalizedCredentialDescriptors(
            input.allowCredentials,
            1
        );
        if (!allowCredentials) return { status: "invalid-input" };

        try {
            const generated = await dependencies.generateAuthenticationOptions({
                allowCredentials,
                rpID: configuration.rpId,
                timeout: webAuthnCeremonyTimeoutMs,
                userVerification: "required",
            });
            const parsed = v.safeParse(
                webAuthnAuthenticationOptionsSchema,
                {
                    allowCredentials: generated.allowCredentials,
                    challenge: generated.challenge,
                    rpId: generated.rpId,
                    timeout: generated.timeout,
                    userVerification: generated.userVerification,
                },
                { abortEarly: true }
            );
            return parsed.success
                ? { options: parsed.output, status: "generated" }
                : { status: "unavailable" };
        } catch {
            return { status: "unavailable" };
        }
    }

    async function verifyRegistration(
        input: VerifyWebAuthnRegistrationInput
    ): Promise<WebAuthnVerificationResult<VerifiedWebAuthnRegistration>> {
        const response = v.safeParse(webAuthnRegistrationResponseSchema, input.response, {
            abortEarly: true,
        });
        if (
            !response.success ||
            !v.safeParse(webAuthnChallengeSchema, input.expectedChallenge, {
                abortEarly: true,
            }).success ||
            !preflightClientData(response.output.response.clientDataJSON, dependencies) ||
            !preflightAttestation(
                response.output.response.attestationObject,
                dependencies
            )
        ) {
            return { status: "invalid-proof" };
        }

        let verified: Awaited<ReturnType<typeof verifySimpleRegistrationResponse>>;
        try {
            verified = await dependencies.verifyRegistrationResponse({
                expectedChallenge: input.expectedChallenge,
                expectedOrigin: [...configuration.allowedOrigins],
                expectedRPID: configuration.rpId,
                expectedType: "webauthn.create",
                requireUserPresence: true,
                requireUserVerification: true,
                response: asRegistrationResponse(response.output),
                supportedAlgorithmIDs: [...supportedAlgorithms],
            });
        } catch {
            return { status: "invalid-proof" };
        }
        if (!verified.verified) return { status: "invalid-proof" };

        const { registrationInfo } = verified;
        const credential = registrationInfo.credential;
        const transports = v.safeParse(
            webAuthnTransportListSchema,
            credential.transports ?? [],
            { abortEarly: true }
        );
        if (
            registrationInfo.fmt !== "none" ||
            registrationInfo.origin === undefined ||
            !configuration.allowedOrigins.includes(registrationInfo.origin) ||
            registrationInfo.rpID !== configuration.rpId ||
            !registrationInfo.userVerified ||
            credential.id !== response.output.id ||
            credential.publicKey.byteLength === 0 ||
            credential.publicKey.byteLength > webAuthnPublicKeyMaximumLength ||
            !transports.success ||
            !hasValidVerificationMetadata({
                backedUp: registrationInfo.credentialBackedUp,
                counter: credential.counter,
                deviceType: registrationInfo.credentialDeviceType,
            })
        ) {
            return { status: "invalid-proof" };
        }

        return {
            status: "verified",
            verification: {
                credential: {
                    algorithm: webAuthnSupportedAlgorithm,
                    counter: credential.counter,
                    id: credential.id,
                    publicKey: Uint8Array.from(credential.publicKey),
                    transports: Object.freeze([...transports.output]),
                },
                credentialBackedUp: registrationInfo.credentialBackedUp,
                credentialDeviceType: registrationInfo.credentialDeviceType,
            },
        };
    }

    async function verifyAuthentication(
        input: VerifyWebAuthnAuthenticationInput
    ): Promise<WebAuthnVerificationResult<VerifiedWebAuthnAuthentication>> {
        const response = v.safeParse(
            webAuthnAuthenticationResponseSchema,
            input.response,
            { abortEarly: true }
        );
        const expectedUserHandle =
            input.expectedUserHandle === undefined
                ? undefined
                : canonicalBase64UrlBytes(
                      input.expectedUserHandle,
                      webAuthnUserHandleByteLength
                  );
        if (
            !response.success ||
            response.output.id !== input.credential.id ||
            input.credential.rpId !== configuration.rpId ||
            !hasValidCredentialState(input.credential) ||
            !v.safeParse(webAuthnChallengeSchema, input.expectedChallenge, {
                abortEarly: true,
            }).success ||
            !preflightClientData(response.output.response.clientDataJSON, dependencies) ||
            (input.expectedUserHandle !== undefined &&
                expectedUserHandle?.byteLength !== webAuthnUserHandleByteLength) ||
            (response.output.response.userHandle !== undefined &&
                response.output.response.userHandle !== input.expectedUserHandle)
        ) {
            return { status: "invalid-proof" };
        }

        const upstreamCredential: WebAuthnCredential = {
            counter: input.credential.counter,
            id: input.credential.id,
            publicKey: Uint8Array.from(input.credential.publicKey),
            ...(input.credential.transports
                ? { transports: [...input.credential.transports] }
                : {}),
        };
        let verified: Awaited<ReturnType<typeof verifySimpleAuthenticationResponse>>;
        try {
            verified = await dependencies.verifyAuthenticationResponse({
                credential: upstreamCredential,
                expectedChallenge: input.expectedChallenge,
                expectedOrigin: [...configuration.allowedOrigins],
                expectedRPID: configuration.rpId,
                expectedType: "webauthn.get",
                requireUserVerification: true,
                response: response.output,
            });
        } catch {
            return { status: "invalid-proof" };
        }

        const authenticationInfo = verified.authenticationInfo;
        if (
            !verified.verified ||
            authenticationInfo.credentialID !== input.credential.id ||
            authenticationInfo.credentialDeviceType !== input.credential.deviceType ||
            !configuration.allowedOrigins.includes(authenticationInfo.origin) ||
            authenticationInfo.rpID !== configuration.rpId ||
            !authenticationInfo.userVerified ||
            !hasValidVerificationMetadata({
                backedUp: authenticationInfo.credentialBackedUp,
                counter: authenticationInfo.newCounter,
                deviceType: authenticationInfo.credentialDeviceType,
            })
        ) {
            return { status: "invalid-proof" };
        }
        return {
            status: "verified",
            verification: {
                credentialBackedUp: authenticationInfo.credentialBackedUp,
                credentialDeviceType: authenticationInfo.credentialDeviceType,
                credentialId: authenticationInfo.credentialID,
                newCounter: authenticationInfo.newCounter,
            },
        };
    }

    return Object.freeze({
        generateAuthenticationOptions: generateAuthentication,
        generateRegistrationOptions: generateRegistration,
        verifyAuthentication,
        verifyRegistration,
    });
}
