import {
    type AuthenticationResponseJSON,
    generateAuthenticationOptions,
    generateRegistrationOptions,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from "@simplewebauthn/server";

import type {
    FactorConfirmation,
    WebAuthnCredential as WebAuthnFactorSummary,
} from "../../../../contracts/accountSecurity.ts";
import { database } from "../../database/connection.ts";
import { normalizeFactorLabel } from "../multiFactorAuth/factorIdentity.ts";
import { totalConfirmedFactorCount } from "../multiFactorAuth/factorInventory.ts";
import {
    enableMultiFactorInTransaction,
    generateRecoveryCodeSet,
} from "../multiFactorAuth/recoveryCodeService.ts";
import { webAuthnConfig } from "./config.ts";
import {
    type WebAuthnChallengeContext,
    type WebAuthnCredentialRow,
    credentialsForUser,
    didConsumeChallenge,
    nowIso,
    parseTransports,
    readChallenge,
    storeChallenge,
    validateChallengeContext,
} from "./repository.ts";

export { type WebAuthnConfig, webAuthnConfig } from "./config.ts";
export type { WebAuthnChallengeContext, WebAuthnChallengePurpose } from "./repository.ts";

const CEREMONY_TIMEOUT_MS = 60_000;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/u;

export interface WebAuthnServerAdapter {
    generateAuthenticationOptions: typeof generateAuthenticationOptions;
    generateRegistrationOptions: typeof generateRegistrationOptions;
    verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
    verifyRegistrationResponse: typeof verifyRegistrationResponse;
}

const defaultWebAuthnServerAdapter: WebAuthnServerAdapter = {
    generateAuthenticationOptions,
    generateRegistrationOptions,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
};

/**
 * Starts registration for an additional named cross-platform security key.
 * @returns Promise resolving to the create web authn registration options result.
 */
export async function createWebAuthnRegistrationOptions(
    context: WebAuthnChallengeContext,
    username: string,
    now = new Date(),
    adapter: WebAuthnServerAdapter = defaultWebAuthnServerAdapter
): Promise<PublicKeyCredentialCreationOptionsJSON> {
    if (context.purpose !== "registration") {
        throw new TypeError("Registration requires a registration challenge");
    }
    validateChallengeContext(context);
    const config = webAuthnConfig();
    const existingCredentials = credentialsForUser(context.userId);
    const options = await adapter.generateRegistrationOptions({
        attestationType: "none",
        authenticatorSelection: {
            authenticatorAttachment: "cross-platform",
            residentKey: "discouraged",
            userVerification: "required",
        },
        excludeCredentials: existingCredentials.map((credential) => ({
            id: credential.id,
            transports: parseTransports(credential.transports_json),
        })),
        preferredAuthenticatorType: "securityKey",
        rpID: config.rpId,
        rpName: config.rpName,
        timeout: CEREMONY_TIMEOUT_MS,
        userDisplayName: username,
        userID: new TextEncoder().encode(`mira-user:${context.userId}`),
        userName: username,
    });
    storeChallenge(context, options.challenge, now);
    return options;
}

/**
 * Completes registration and returns recovery codes only for the first factor.
 * @returns Promise resolving to the verify web authn registration result.
 */
export async function verifyWebAuthnRegistration(
    context: WebAuthnChallengeContext,
    response: RegistrationResponseJSON,
    label: string,
    now = new Date(),
    adapter: WebAuthnServerAdapter = defaultWebAuthnServerAdapter
): Promise<
    | {
          confirmation: FactorConfirmation;
          credential: WebAuthnFactorSummary;
      }
    | undefined
> {
    if (context.purpose !== "registration" || !CREDENTIAL_ID_PATTERN.test(response.id)) {
        return undefined;
    }
    const challenge = readChallenge(context, now);
    if (!challenge) {
        return undefined;
    }
    const config = webAuthnConfig();
    let verification;
    try {
        verification = await adapter.verifyRegistrationResponse({
            expectedChallenge: challenge.challenge,
            expectedOrigin: config.expectedOrigins,
            expectedRPID: config.rpId,
            requireUserPresence: true,
            requireUserVerification: true,
            response,
        });
    } catch {
        didConsumeChallenge(challenge.id);
        return undefined;
    }
    if (!verification.verified) {
        didConsumeChallenge(challenge.id);
        return undefined;
    }

    const normalizedLabel = normalizeFactorLabel(label, "Security key");
    const registration = verification.registrationInfo;
    const timestamp = nowIso(now);
    const user = database
        .prepare("SELECT mfa_enabled_at FROM users WHERE id = ?")
        .get(context.userId) as { mfa_enabled_at: string | null } | undefined;
    const generatedRecoveryCodes = user?.mfa_enabled_at
        ? undefined
        : await generateRecoveryCodeSet();

    database.run("BEGIN IMMEDIATE");
    try {
        const consumed = database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE id = ?")
            .run(challenge.id);
        if (consumed.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        database
            .prepare(
                `INSERT INTO user_webauthn_credentials (
                    id,
                    user_id,
                    public_key,
                    counter,
                    transports_json,
                    device_type,
                    backed_up,
                    label,
                    created_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                registration.credential.id,
                context.userId,
                registration.credential.publicKey,
                registration.credential.counter,
                JSON.stringify(
                    registration.credential.transports ??
                        response.response.transports ??
                        []
                ),
                registration.credentialDeviceType,
                registration.credentialBackedUp ? 1 : 0,
                normalizedLabel,
                timestamp
            );
        const confirmation = generatedRecoveryCodes
            ? enableMultiFactorInTransaction(
                  context.userId,
                  generatedRecoveryCodes,
                  timestamp
              )
            : { enabledMfa: false };
        database.run("COMMIT");
        return {
            confirmation,
            credential: {
                backedUp: registration.credentialBackedUp,
                createdAt: timestamp,
                deviceType: registration.credentialDeviceType,
                id: registration.credential.id,
                label: normalizedLabel,
            },
        };
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "WebAuthn registration and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

/**
 * Starts a user-bound WebAuthn login or step-up assertion.
 * @returns Promise resolving to the create web authn authentication options result.
 */
export async function createWebAuthnAuthenticationOptions(
    context: WebAuthnChallengeContext,
    now = new Date(),
    adapter: WebAuthnServerAdapter = defaultWebAuthnServerAdapter
): Promise<PublicKeyCredentialRequestOptionsJSON> {
    if (context.purpose === "registration") {
        throw new TypeError("Authentication requires a login or step-up challenge");
    }
    validateChallengeContext(context);
    const config = webAuthnConfig();
    const credentials = credentialsForUser(context.userId);
    if (credentials.length === 0) {
        throw new Error("No WebAuthn credentials are configured");
    }
    const options = await adapter.generateAuthenticationOptions({
        allowCredentials: credentials.map((credential) => ({
            id: credential.id,
            transports: parseTransports(credential.transports_json),
        })),
        rpID: config.rpId,
        timeout: CEREMONY_TIMEOUT_MS,
        userVerification: "required",
    });
    storeChallenge(context, options.challenge, now);
    return options;
}

/**
 * Verifies and atomically consumes one user-bound WebAuthn assertion.
 * @returns Promise resolving to the verify web authn authentication result.
 */
export async function verifyWebAuthnAuthentication(
    context: WebAuthnChallengeContext,
    response: AuthenticationResponseJSON,
    now = new Date(),
    adapter: WebAuthnServerAdapter = defaultWebAuthnServerAdapter
): Promise<WebAuthnFactorSummary | undefined> {
    if (context.purpose === "registration" || !CREDENTIAL_ID_PATTERN.test(response.id)) {
        return undefined;
    }
    const challenge = readChallenge(context, now);
    const credential = database
        .prepare(
            `SELECT id,
                    user_id,
                    public_key,
                    counter,
                    transports_json,
                    device_type,
                    backed_up,
                    label,
                    created_at,
                    last_used_at
             FROM user_webauthn_credentials
             WHERE id = ? AND user_id = ?`
        )
        .get(response.id, context.userId) as WebAuthnCredentialRow | undefined;
    if (!challenge || !credential) {
        if (challenge) {
            didConsumeChallenge(challenge.id);
        }
        return undefined;
    }

    const config = webAuthnConfig();
    let verification;
    try {
        verification = await adapter.verifyAuthenticationResponse({
            credential: {
                counter: credential.counter,
                id: credential.id,
                publicKey: new Uint8Array(credential.public_key),
                transports: parseTransports(credential.transports_json),
            },
            expectedChallenge: challenge.challenge,
            expectedOrigin: config.expectedOrigins,
            expectedRPID: config.rpId,
            requireUserVerification: true,
            response,
        });
    } catch {
        didConsumeChallenge(challenge.id);
        return undefined;
    }
    if (!verification.verified) {
        didConsumeChallenge(challenge.id);
        return undefined;
    }

    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        const consumed = database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE id = ?")
            .run(challenge.id);
        if (consumed.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        const updated = database
            .prepare(
                `UPDATE user_webauthn_credentials
                 SET counter = ?,
                     device_type = ?,
                     backed_up = ?,
                     last_used_at = ?
                 WHERE id = ? AND user_id = ? AND counter = ?`
            )
            .run(
                verification.authenticationInfo.newCounter,
                verification.authenticationInfo.credentialDeviceType,
                verification.authenticationInfo.credentialBackedUp ? 1 : 0,
                timestamp,
                credential.id,
                context.userId,
                credential.counter
            );
        if (updated.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        database.run("COMMIT");
        return {
            backedUp: verification.authenticationInfo.credentialBackedUp,
            createdAt: credential.created_at,
            deviceType: verification.authenticationInfo.credentialDeviceType,
            id: credential.id,
            label: credential.label,
            lastUsedAt: timestamp,
        };
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "WebAuthn authentication and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

/**
 * Removes one key while preserving at least one active second factor.
 * @param userId User identifier.
 * @param credentialId Credential identifier.
 * @returns Did remove web authn credential result.
 */
export function didRemoveWebAuthnCredential(
    userId: number,
    credentialId: string
): boolean {
    if (!CREDENTIAL_ID_PATTERN.test(credentialId)) {
        return false;
    }
    database.run("BEGIN IMMEDIATE");
    try {
        if (totalConfirmedFactorCount(userId) <= 1) {
            database.run("ROLLBACK");
            return false;
        }
        const deleted = database
            .prepare(
                `DELETE FROM user_webauthn_credentials
                 WHERE id = ? AND user_id = ?`
            )
            .run(credentialId, userId);
        database.run("COMMIT");
        return deleted.changes === 1;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "WebAuthn credential removal and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

/** Fails startup when persisted WebAuthn data lacks an explicit RP configuration. */
export function validateWebAuthnConfig(): void {
    const row = database
        .prepare(
            `SELECT EXISTS (
                SELECT 1 FROM user_webauthn_credentials
             ) AS configured`
        )
        .get() as { configured: number };
    if (
        row.configured === 1 ||
        process.env.MIRA_DASHBOARD_WEBAUTHN_RP_ID?.trim() ||
        process.env.MIRA_DASHBOARD_WEBAUTHN_ORIGINS?.trim()
    ) {
        webAuthnConfig();
    }
}
