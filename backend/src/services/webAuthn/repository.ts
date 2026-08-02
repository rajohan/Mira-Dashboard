import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";

import { database, sqlNullable } from "../../database.ts";

const CHALLENGE_TTL_MS = 5 * 60_000;
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

export interface WebAuthnChallengeContext {
    pendingLoginId?: string;
    purpose: WebAuthnChallengePurpose;
    sessionId?: string;
    userId: number;
}

export interface WebAuthnChallengeRow {
    challenge: string;
    expires_at: string;
    id: string;
}

export interface WebAuthnCredentialRow {
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

export function nowIso(now = new Date()): string {
    return now.toISOString();
}
export function validateChallengeContext(context: WebAuthnChallengeContext): void {
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

export function storeChallenge(
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
            const rollbackFailure = new AggregateError(
                [error, rollbackError],
                "WebAuthn challenge storage and rollback failed",
                { cause: error }
            );
            throw rollbackFailure;
        }
        throw error;
    }
}

export function readChallenge(
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
        | WebAuthnChallengeRow
        | undefined;
}

export function didConsumeChallenge(challengeId: string): boolean {
    return (
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE id = ?")
            .run(challengeId).changes === 1
    );
}

export function parseTransports(value: string): AuthenticatorTransportFuture[] {
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

export function credentialsForUser(userId: number): WebAuthnCredentialRow[] {
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
