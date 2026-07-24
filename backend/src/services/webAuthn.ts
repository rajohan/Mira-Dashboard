import {
    type AuthenticationResponseJSON,
    type AuthenticatorTransportFuture,
    generateAuthenticationOptions,
    generateRegistrationOptions,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
    type RegistrationResponseJSON,
    verifyAuthenticationResponse,
    verifyRegistrationResponse,
} from "@simplewebauthn/server";

import { database, sqlNullable } from "../database.ts";
import {
    enableMultiFactorInTransaction,
    type FactorConfirmation,
    generateRecoveryCodeSet,
    normalizeFactorLabel,
    totalConfirmedFactorCount,
    type WebAuthnFactorSummary,
} from "./multiFactorAuth.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;
const CEREMONY_TIMEOUT_MS = 60_000;
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{8,1024}$/u;
const RP_ID_PATTERN =
    /^(?:localhost|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/u;
const ALLOWED_TRANSPORTS = new Set<AuthenticatorTransportFuture>([
    "ble",
    "cable",
    "hybrid",
    "internal",
    "nfc",
    "smart-card",
    "usb",
]);

export type WebAuthnChallengePurpose = "login" | "registration" | "step-up";

export interface WebAuthnConfig {
    expectedOrigins: string[];
    rpId: string;
    rpName: string;
}

export interface WebAuthnChallengeContext {
    pendingLoginId?: string;
    purpose: WebAuthnChallengePurpose;
    sessionId?: string;
    userId: number;
}

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

interface WebAuthnChallengeRow {
    challenge: string;
    expires_at: string;
    id: string;
}

interface WebAuthnCredentialRow {
    backed_up: number;
    counter: number;
    created_at: string;
    device_type: "multiDevice" | "singleDevice";
    id: string;
    label: string;
    last_used_at: string | null;
    public_key: Uint8Array;
    transports_json: string;
    user_id: number;
}

function nowIso(now = new Date()): string {
    return now.toISOString();
}

function isIpv4Hostname(hostname: string): boolean {
    const octets = hostname.split(".");
    return (
        octets.length === 4 &&
        octets.every((octet) => /^\d{1,3}$/u.test(octet)) &&
        octets.every((octet) => Number(octet) <= 255)
    );
}

function normalizeRpId(value: string | undefined): string {
    const rpId = value?.trim().toLowerCase();
    if (!rpId || rpId.length > 253 || !RP_ID_PATTERN.test(rpId) || isIpv4Hostname(rpId)) {
        throw new TypeError(
            "MIRA_DASHBOARD_WEBAUTHN_RP_ID must be a stable DNS hostname"
        );
    }
    return rpId;
}

function normalizeOrigins(value: string | undefined, rpId: string): string[] {
    const configured = value
        ?.split(",")
        .map((origin) => origin.trim())
        .filter(Boolean);
    if (!configured?.length) {
        throw new TypeError(
            "MIRA_DASHBOARD_WEBAUTHN_ORIGINS must contain at least one explicit origin"
        );
    }
    const normalized = new Set<string>();
    for (const configuredOrigin of configured) {
        let parsed: URL;
        try {
            parsed = new URL(configuredOrigin);
        } catch {
            throw new TypeError(`Invalid WebAuthn origin: ${configuredOrigin}`);
        }
        const isLocalDevelopment =
            parsed.hostname === "localhost" || parsed.hostname.endsWith(".localhost");
        const hasValidProtocol =
            parsed.protocol === "https:" ||
            (isLocalDevelopment && parsed.protocol === "http:");
        if (
            !hasValidProtocol ||
            parsed.username ||
            parsed.password ||
            (parsed.pathname !== "/" && parsed.pathname !== "") ||
            parsed.search ||
            parsed.hash
        ) {
            throw new TypeError(
                `WebAuthn origin must be an HTTPS origin without a path: ${configuredOrigin}`
            );
        }
        const hostname = parsed.hostname.toLowerCase();
        if (hostname !== rpId && !hostname.endsWith(`.${rpId}`)) {
            throw new TypeError(
                `WebAuthn origin ${parsed.origin} is outside RP ID ${rpId}`
            );
        }
        normalized.add(parsed.origin);
    }
    return [...normalized];
}

/** Resolves the explicit, origin-bound WebAuthn relying-party configuration. */
export function webAuthnConfig(
    environment: Record<string, string | undefined> = process.env
): WebAuthnConfig {
    const rpId = normalizeRpId(environment.MIRA_DASHBOARD_WEBAUTHN_RP_ID);
    return {
        expectedOrigins: normalizeOrigins(
            environment.MIRA_DASHBOARD_WEBAUTHN_ORIGINS,
            rpId
        ),
        rpId,
        rpName: "Mira Dashboard",
    };
}

function validateChallengeContext(context: WebAuthnChallengeContext): void {
    const hasSession = Boolean(context.sessionId);
    const hasPendingLogin = Boolean(context.pendingLoginId);
    if (hasSession === hasPendingLogin) {
        throw new TypeError(
            "WebAuthn challenge must belong to exactly one session or pending login"
        );
    }
    if (
        (!hasPendingLogin && context.purpose === "login") ||
        (!hasSession && context.purpose !== "login")
    ) {
        throw new TypeError("Invalid WebAuthn challenge context");
    }
}

function challengeContextParameters(
    context: WebAuthnChallengeContext
): [
    number,
    WebAuthnChallengePurpose,
    ReturnType<typeof sqlNullable>,
    ReturnType<typeof sqlNullable>,
] {
    validateChallengeContext(context);
    return [
        context.userId,
        context.purpose,
        sqlNullable(context.sessionId),
        sqlNullable(context.pendingLoginId),
    ];
}

function storeChallenge(
    context: WebAuthnChallengeContext,
    challenge: string,
    now = new Date()
): void {
    const [userId, purpose, sessionId, pendingLoginId] =
        challengeContextParameters(context);
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare(
                `DELETE FROM auth_webauthn_challenges
                 WHERE user_id = ?
                   AND purpose = ?
                   AND session_id IS ?
                   AND pending_login_id IS ?`
            )
            .run(userId, purpose, sessionId, pendingLoginId);
        database
            .prepare(
                `INSERT INTO auth_webauthn_challenges (
                    id,
                    user_id,
                    session_id,
                    pending_login_id,
                    purpose,
                    challenge,
                    created_at,
                    expires_at
                 ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
                Bun.randomUUIDv7(),
                userId,
                sessionId,
                pendingLoginId,
                purpose,
                challenge,
                timestamp,
                new Date(now.getTime() + CHALLENGE_TTL_MS).toISOString()
            );
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "WebAuthn challenge storage and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

function readChallenge(
    context: WebAuthnChallengeContext,
    now = new Date()
): WebAuthnChallengeRow | undefined {
    const [userId, purpose, sessionId, pendingLoginId] =
        challengeContextParameters(context);
    return database
        .prepare(
            `SELECT id, challenge, expires_at
             FROM auth_webauthn_challenges
             WHERE user_id = ?
               AND purpose = ?
               AND session_id IS ?
               AND pending_login_id IS ?
               AND expires_at > ?
             ORDER BY created_at DESC, id DESC
             LIMIT 1`
        )
        .get(userId, purpose, sessionId, pendingLoginId, nowIso(now)) as
        WebAuthnChallengeRow | undefined;
}

function didConsumeChallenge(challengeId: string): boolean {
    return (
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE id = ?")
            .run(challengeId).changes === 1
    );
}

function parseTransports(value: string): AuthenticatorTransportFuture[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(value) as unknown;
    } catch {
        return [];
    }
    if (!Array.isArray(parsed)) {
        return [];
    }
    return parsed.filter(
        (transport): transport is AuthenticatorTransportFuture =>
            typeof transport === "string" &&
            ALLOWED_TRANSPORTS.has(transport as AuthenticatorTransportFuture)
    );
}

function credentialsForUser(userId: number): WebAuthnCredentialRow[] {
    return database
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
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as WebAuthnCredentialRow[];
}

/** Starts registration for an additional named cross-platform security key. */
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

/** Completes registration and returns recovery codes only for the first factor. */
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
            throw new AggregateError(
                [error, rollbackError],
                "WebAuthn registration and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Starts a user-bound WebAuthn login or step-up assertion. */
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

/** Verifies and atomically consumes one user-bound WebAuthn assertion. */
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
            throw new AggregateError(
                [error, rollbackError],
                "WebAuthn authentication and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Removes one key while preserving at least one active second factor. */
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
            throw new AggregateError(
                [error, rollbackError],
                "WebAuthn credential removal and rollback failed",
                { cause: rollbackError }
            );
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
