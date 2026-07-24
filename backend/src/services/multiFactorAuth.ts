import { generateSecret, generateURI, verify } from "otplib";

import type { AuthMethod } from "../auth.ts";
import { database, sqlNullable } from "../database.ts";
import {
    areTimingSafeHashesEqual,
    decryptStoredSecret,
    encryptStoredSecret,
    randomHex,
    secretEncryptionKeyBytes,
    sha256Hex,
} from "./mfaCrypto.ts";

const PENDING_LOGIN_TTL_MS = 5 * 60_000;
const MAX_PENDING_LOGIN_ATTEMPTS = 8;
const PENDING_SELECTOR_BYTES = 16;
const PENDING_VALIDATOR_BYTES = 32;
const PENDING_TOKEN_PATTERN = /^([a-f0-9]{32})\.([a-f0-9]{64})$/u;
const RECOVERY_SELECTOR_BYTES = 4;
const RECOVERY_VALIDATOR_BYTES = 16;
const RECOVERY_CODE_COUNT = 10;
const RECOVERY_CODE_PATTERN = /^([a-f0-9]{8})-([a-f0-9]{32})$/u;
const TOTP_TOKEN_PATTERN = /^\d{6}$/u;
const FACTOR_ID_PATTERN = /^[0-9a-f-]{36}$/u;
const MAX_FACTOR_LABEL_LENGTH = 64;
const MAX_USER_AGENT_LENGTH = 512;

export type MfaLoginMethod = Exclude<AuthMethod, "password">;

interface PendingLoginRow {
    attempt_count: number;
    created_at: string;
    expires_at: string;
    id: string;
    methods_json: string;
    user_agent: string | null;
    user_id: number;
    username: string;
    validator_hash: string;
}

interface TotpFactorRow {
    confirmed_at: string | null;
    created_at: string;
    encrypted_secret: string;
    id: string;
    label: string;
    last_used_step: number | null;
    user_id: number;
}

interface WebAuthnFactorSummaryRow {
    backed_up: number;
    created_at: string;
    device_type: "multiDevice" | "singleDevice";
    id: string;
    label: string;
    last_used_at: string | null;
}

export interface PendingLogin {
    attemptCount: number;
    createdAt: string;
    expiresAt: string;
    methods: MfaLoginMethod[];
    pendingLoginId: string;
    userAgent?: string;
    userId: number;
    username: string;
}

export interface TotpFactorSummary {
    confirmedAt: string;
    createdAt: string;
    id: string;
    label: string;
}

export interface WebAuthnFactorSummary {
    backedUp: boolean;
    createdAt: string;
    deviceType: "multiDevice" | "singleDevice";
    id: string;
    label: string;
    lastUsedAt?: string;
}

export interface MultiFactorSummary {
    enabledAt?: string;
    methods: MfaLoginMethod[];
    recoveryCodesRemaining: number;
    totpFactors: TotpFactorSummary[];
    webAuthnCredentials: WebAuthnFactorSummary[];
}

export interface TotpEnrollment {
    factorId: string;
    label: string;
    otpauthUri: string;
    secret: string;
}

export interface FactorConfirmation {
    enabledMfa: boolean;
    recoveryCodes?: string[];
}

function nowIso(now = new Date()): string {
    return now.toISOString();
}

function normalizeUserAgent(userAgent?: string): string | undefined {
    const normalized = userAgent?.replaceAll("\0", "").trim();
    return normalized ? normalized.slice(0, MAX_USER_AGENT_LENGTH) : undefined;
}

/** Validates and normalizes a user-visible factor label. */
export function normalizeFactorLabel(value: unknown, fallback: string): string {
    if (value === undefined) {
        return fallback;
    }
    if (typeof value !== "string") {
        throw new TypeError("Factor label must be a string");
    }
    const normalized = value.replaceAll("\0", "").trim();
    if (!normalized || normalized.length > MAX_FACTOR_LABEL_LENGTH) {
        throw new TypeError(
            `Factor label must be 1-${MAX_FACTOR_LABEL_LENGTH} characters`
        );
    }
    return normalized;
}

/** Validates an opaque factor identifier before using it in a query. */
export function normalizeFactorId(value: unknown): string {
    if (typeof value !== "string" || !FACTOR_ID_PATTERN.test(value)) {
        throw new TypeError("Invalid factor identifier");
    }
    return value;
}

function pendingTokenParts(
    pendingToken: string
): { selector: string; validatorHash: string } | undefined {
    const match = pendingToken.match(PENDING_TOKEN_PATTERN);
    const selector = match?.[1];
    const validator = match?.[2];
    return selector && validator
        ? { selector, validatorHash: sha256Hex(validator) }
        : undefined;
}

/** Removes expired pending logins, WebAuthn challenges, and abandoned TOTP setups. */
export function cleanupExpiredMultiFactorState(now = new Date()): void {
    const timestamp = nowIso(now);
    const abandonedEnrollmentCutoff = new Date(
        now.getTime() - PENDING_LOGIN_TTL_MS
    ).toISOString();
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE expires_at <= ?")
            .run(timestamp);
        database
            .prepare("DELETE FROM auth_pending_logins WHERE expires_at <= ?")
            .run(timestamp);
        database
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE confirmed_at IS NULL AND created_at <= ?`
            )
            .run(abandonedEnrollmentCutoff);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "MFA cleanup and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Returns the usable second-factor methods configured for one user. */
export function mfaMethodsForUser(userId: number): MfaLoginMethod[] {
    const counts = database
        .prepare(
            `SELECT
                (
                    SELECT COUNT(*)
                    FROM user_totp_factors
                    WHERE user_id = ? AND confirmed_at IS NOT NULL
                ) AS totp_count,
                (
                    SELECT COUNT(*)
                    FROM user_webauthn_credentials
                    WHERE user_id = ?
                ) AS webauthn_count,
                (
                    SELECT COUNT(*)
                    FROM user_recovery_codes
                    WHERE user_id = ? AND used_at IS NULL
                ) AS recovery_count`
        )
        .get(userId, userId, userId) as {
        recovery_count: number;
        totp_count: number;
        webauthn_count: number;
    };
    return [
        ...(counts.webauthn_count > 0 ? (["webauthn"] as const) : []),
        ...(counts.totp_count > 0 ? (["totp"] as const) : []),
        ...(counts.recovery_count > 0 ? (["recovery"] as const) : []),
    ];
}

/** Creates one short-lived password-verified login transaction. */
export function createPendingLogin(
    userId: number,
    methods: MfaLoginMethod[],
    userAgent?: string,
    now = new Date()
): string {
    if (methods.length === 0) {
        throw new Error("No MFA methods are configured");
    }
    cleanupExpiredMultiFactorState(now);
    const selector = randomHex(PENDING_SELECTOR_BYTES);
    const validator = randomHex(PENDING_VALIDATOR_BYTES);
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_pending_logins WHERE user_id = ?").run(userId);
        database
            .prepare(
                `INSERT INTO auth_pending_logins (
                    id,
                    validator_hash,
                    user_id,
                    methods_json,
                    attempt_count,
                    user_agent,
                    created_at,
                    expires_at
                 ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)`
            )
            .run(
                selector,
                sha256Hex(validator),
                userId,
                JSON.stringify(methods),
                sqlNullable(normalizeUserAgent(userAgent)),
                timestamp,
                new Date(now.getTime() + PENDING_LOGIN_TTL_MS).toISOString()
            );
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "Pending login creation and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
    return `${selector}.${validator}`;
}

/** Resolves a pending-login token without exposing its validator. */
export function getPendingLogin(
    pendingToken: string,
    now = new Date()
): PendingLogin | undefined {
    const parsed = pendingTokenParts(pendingToken);
    if (!parsed) {
        return undefined;
    }
    cleanupExpiredMultiFactorState(now);
    const row = database
        .prepare(
            `SELECT p.id,
                    p.validator_hash,
                    p.user_id,
                    p.methods_json,
                    p.attempt_count,
                    p.user_agent,
                    p.created_at,
                    p.expires_at,
                    u.username
             FROM auth_pending_logins p
             JOIN users u ON u.id = p.user_id
             WHERE p.id = ? AND p.expires_at > ?`
        )
        .get(parsed.selector, nowIso(now)) as PendingLoginRow | undefined;
    if (
        !row ||
        row.attempt_count >= MAX_PENDING_LOGIN_ATTEMPTS ||
        !areTimingSafeHashesEqual(row.validator_hash, parsed.validatorHash)
    ) {
        return undefined;
    }
    let methods: unknown;
    try {
        methods = JSON.parse(row.methods_json) as unknown;
    } catch {
        return undefined;
    }
    if (
        !Array.isArray(methods) ||
        methods.some(
            (method) =>
                method !== "recovery" && method !== "totp" && method !== "webauthn"
        )
    ) {
        return undefined;
    }
    return {
        attemptCount: row.attempt_count,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        methods: methods as MfaLoginMethod[],
        pendingLoginId: row.id,
        ...(row.user_agent && { userAgent: row.user_agent }),
        userId: row.user_id,
        username: row.username,
    };
}

/** Records a failed second-factor attempt and consumes exhausted login state. */
export function recordPendingLoginFailure(pendingLoginId: string): void {
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare(
                `UPDATE auth_pending_logins
                 SET attempt_count = attempt_count + 1
                 WHERE id = ?`
            )
            .run(pendingLoginId);
        database
            .prepare(
                `DELETE FROM auth_pending_logins
                 WHERE id = ? AND attempt_count >= ?`
            )
            .run(pendingLoginId, MAX_PENDING_LOGIN_ATTEMPTS);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "Pending login failure update and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Atomically consumes a pending login after successful factor verification. */
export function consumePendingLogin(pendingToken: string): PendingLogin | undefined {
    const pending = getPendingLogin(pendingToken);
    const parsed = pendingTokenParts(pendingToken);
    if (!pending || !parsed) {
        return undefined;
    }
    const deleted = database
        .prepare(
            `DELETE FROM auth_pending_logins
             WHERE id = ? AND validator_hash = ?`
        )
        .run(parsed.selector, parsed.validatorHash);
    return deleted.changes === 1 ? pending : undefined;
}

function totpAssociatedData(userId: number, factorId: string): string {
    return `mira-dashboard:totp:v1:user:${userId}:factor:${factorId}`;
}

/** Creates an encrypted, inactive TOTP enrollment. */
export async function createTotpEnrollment(
    userId: number,
    username: string,
    label: string,
    now = new Date()
): Promise<TotpEnrollment> {
    const factorId = Bun.randomUUIDv7();
    const secret = generateSecret({ length: 20 });
    const encryptedSecret = encryptStoredSecret(
        secret,
        totpAssociatedData(userId, factorId)
    );
    const normalizedLabel = normalizeFactorLabel(label, "Authenticator app");
    database.run("BEGIN IMMEDIATE");
    try {
        database
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE user_id = ? AND confirmed_at IS NULL`
            )
            .run(userId);
        database
            .prepare(
                `INSERT INTO user_totp_factors (
                    id,
                    user_id,
                    label,
                    encrypted_secret,
                    created_at
                 ) VALUES (?, ?, ?, ?, ?)`
            )
            .run(factorId, userId, normalizedLabel, encryptedSecret, nowIso(now));
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "TOTP enrollment creation and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
    return {
        factorId,
        label: normalizedLabel,
        otpauthUri: generateURI({
            algorithm: "sha1",
            digits: 6,
            issuer: "Mira Dashboard",
            label: username,
            period: 30,
            secret,
        }),
        secret,
    };
}

async function verifyTotpToken(
    factor: TotpFactorRow,
    token: string
): Promise<{ timeStep: number } | undefined> {
    if (!TOTP_TOKEN_PATTERN.test(token)) {
        return undefined;
    }
    const secret = decryptStoredSecret(
        factor.encrypted_secret,
        totpAssociatedData(factor.user_id, factor.id)
    );
    const result = await verify({
        ...(factor.last_used_step !== null && {
            afterTimeStep: factor.last_used_step,
        }),
        algorithm: "sha1",
        digits: 6,
        epochTolerance: [30, 0],
        period: 30,
        secret,
        strategy: "totp",
        token,
    });
    return result.valid && "timeStep" in result
        ? { timeStep: result.timeStep }
        : undefined;
}

function userMfaEnabledAt(userId: number): string | undefined {
    const row = database
        .prepare("SELECT mfa_enabled_at FROM users WHERE id = ?")
        .get(userId) as { mfa_enabled_at: string | null } | undefined;
    return row?.mfa_enabled_at ?? undefined;
}

export interface GeneratedRecoveryCode {
    code: string;
    selector: string;
    validatorHash: string;
}

/** Prepares one recovery-code set without persisting plaintext code material. */
export async function generateRecoveryCodeSet(): Promise<GeneratedRecoveryCode[]> {
    return Promise.all(
        Array.from({ length: RECOVERY_CODE_COUNT }, async () => {
            const selector = randomHex(RECOVERY_SELECTOR_BYTES);
            const validator = randomHex(RECOVERY_VALIDATOR_BYTES);
            return {
                code: `${selector}-${validator}`,
                selector,
                validatorHash: await Bun.password.hash(validator),
            };
        })
    );
}

function insertRecoveryCodeSet(
    userId: number,
    generated: GeneratedRecoveryCode[],
    createdAt: string
): void {
    const insert = database.prepare(
        `INSERT INTO user_recovery_codes (
            id, user_id, validator_hash, created_at
         ) VALUES (?, ?, ?, ?)`
    );
    for (const code of generated) {
        insert.run(code.selector, userId, code.validatorHash, createdAt);
    }
}

/**
 * Enables MFA and persists a prepared recovery-code set.
 *
 * This must run inside the same immediate transaction that activates the first
 * factor. The conditional user update ensures concurrent enrollments cannot
 * both replace the recovery-code set or reveal an unusable set.
 */
export function enableMultiFactorInTransaction(
    userId: number,
    generatedRecoveryCodes: GeneratedRecoveryCode[],
    timestamp: string
): FactorConfirmation {
    const enabled = database
        .prepare(
            `UPDATE users
             SET mfa_enabled_at = ?, updated_at = ?
             WHERE id = ? AND mfa_enabled_at IS NULL`
        )
        .run(timestamp, timestamp, userId);
    if (enabled.changes !== 1) {
        return { enabledMfa: false };
    }
    database.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
    insertRecoveryCodeSet(userId, generatedRecoveryCodes, timestamp);
    return {
        enabledMfa: true,
        recoveryCodes: generatedRecoveryCodes.map((code) => code.code),
    };
}

/** Confirms an encrypted TOTP enrollment and prevents time-step replay. */
export async function confirmTotpEnrollment(
    userId: number,
    factorId: string,
    token: string,
    now = new Date()
): Promise<FactorConfirmation | undefined> {
    const factor = database
        .prepare(
            `SELECT id,
                    user_id,
                    label,
                    encrypted_secret,
                    last_used_step,
                    created_at,
                    confirmed_at
             FROM user_totp_factors
             WHERE id = ? AND user_id = ? AND confirmed_at IS NULL`
        )
        .get(factorId, userId) as TotpFactorRow | undefined;
    if (!factor) {
        return undefined;
    }
    const verified = await verifyTotpToken(factor, token);
    if (!verified) {
        return undefined;
    }

    const shouldEnableMfa = !userMfaEnabledAt(userId);
    const generatedRecoveryCodes = shouldEnableMfa
        ? await generateRecoveryCodeSet()
        : undefined;
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        const confirmed = database
            .prepare(
                `UPDATE user_totp_factors
                 SET confirmed_at = ?, last_used_step = ?
                 WHERE id = ?
                   AND user_id = ?
                   AND confirmed_at IS NULL
                   AND (last_used_step IS NULL OR last_used_step < ?)`
            )
            .run(timestamp, verified.timeStep, factorId, userId, verified.timeStep);
        if (confirmed.changes !== 1) {
            database.run("ROLLBACK");
            return undefined;
        }
        const confirmation = generatedRecoveryCodes
            ? enableMultiFactorInTransaction(userId, generatedRecoveryCodes, timestamp)
            : { enabledMfa: false };
        database.run("COMMIT");
        return confirmation;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "TOTP confirmation and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Verifies one confirmed authenticator-app code and atomically records its time step. */
export async function verifyTotpForUser(
    userId: number,
    token: string
): Promise<TotpFactorSummary | undefined> {
    if (!TOTP_TOKEN_PATTERN.test(token)) {
        return undefined;
    }
    const factors = database
        .prepare(
            `SELECT id,
                    user_id,
                    label,
                    encrypted_secret,
                    last_used_step,
                    created_at,
                    confirmed_at
             FROM user_totp_factors
             WHERE user_id = ? AND confirmed_at IS NOT NULL
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as TotpFactorRow[];
    for (const factor of factors) {
        const verified = await verifyTotpToken(factor, token);
        if (!verified) continue;
        const updated = database
            .prepare(
                `UPDATE user_totp_factors
                 SET last_used_step = ?
                 WHERE id = ?
                   AND user_id = ?
                   AND (last_used_step IS NULL OR last_used_step < ?)`
            )
            .run(verified.timeStep, factor.id, userId, verified.timeStep);
        if (updated.changes === 1 && factor.confirmed_at) {
            return {
                confirmedAt: factor.confirmed_at,
                createdAt: factor.created_at,
                id: factor.id,
                label: factor.label,
            };
        }
    }
    return undefined;
}

/** Returns the number of active TOTP and WebAuthn factors for one user. */
export function totalConfirmedFactorCount(userId: number): number {
    const row = database
        .prepare(
            `SELECT
                (
                    SELECT COUNT(*)
                    FROM user_totp_factors
                    WHERE user_id = ? AND confirmed_at IS NOT NULL
                ) + (
                    SELECT COUNT(*)
                    FROM user_webauthn_credentials
                    WHERE user_id = ?
                ) AS count`
        )
        .get(userId, userId) as { count: number };
    return row.count;
}

/** Removes a TOTP factor without allowing deletion of the final second factor. */
export function didRemoveTotpFactor(userId: number, factorId: string): boolean {
    database.run("BEGIN IMMEDIATE");
    try {
        if (totalConfirmedFactorCount(userId) <= 1) {
            database.run("ROLLBACK");
            return false;
        }
        const deleted = database
            .prepare(
                `DELETE FROM user_totp_factors
                 WHERE id = ? AND user_id = ? AND confirmed_at IS NOT NULL`
            )
            .run(factorId, userId);
        database.run("COMMIT");
        return deleted.changes === 1;
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "TOTP removal and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Generates and replaces the user's one-time recovery codes. */
export async function rotateRecoveryCodes(
    userId: number,
    now = new Date()
): Promise<string[]> {
    const generated = await generateRecoveryCodeSet();
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
        insertRecoveryCodeSet(userId, generated, timestamp);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "Recovery-code rotation and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
    return generated.map((code) => code.code);
}

/** Consumes one high-entropy recovery code after password-hash verification. */
export async function verifyRecoveryCodeForUser(
    userId: number,
    code: string,
    now = new Date()
): Promise<boolean> {
    const normalized = code.trim().toLowerCase();
    const match = normalized.match(RECOVERY_CODE_PATTERN);
    const selector = match?.[1];
    const validator = match?.[2];
    if (!selector || !validator) {
        return false;
    }
    const row = database
        .prepare(
            `SELECT validator_hash
             FROM user_recovery_codes
             WHERE id = ? AND user_id = ? AND used_at IS NULL`
        )
        .get(selector, userId) as { validator_hash: string } | undefined;
    if (!row) {
        return false;
    }
    try {
        const isValid = await Bun.password.verify(validator, row.validator_hash);
        if (!isValid) {
            return false;
        }
    } catch {
        return false;
    }
    return (
        database
            .prepare(
                `UPDATE user_recovery_codes
                 SET used_at = ?
                 WHERE id = ? AND user_id = ? AND used_at IS NULL`
            )
            .run(nowIso(now), selector, userId).changes === 1
    );
}

/** Returns factor and recovery status without exposing secrets or hashes. */
export function getMultiFactorSummary(userId: number): MultiFactorSummary {
    const user = database
        .prepare("SELECT mfa_enabled_at FROM users WHERE id = ?")
        .get(userId) as { mfa_enabled_at: string | null } | undefined;
    const totpFactors = database
        .prepare(
            `SELECT id, label, created_at, confirmed_at
             FROM user_totp_factors
             WHERE user_id = ? AND confirmed_at IS NOT NULL
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as Array<{
        confirmed_at: string;
        created_at: string;
        id: string;
        label: string;
    }>;
    const webAuthnCredentials = database
        .prepare(
            `SELECT id,
                    label,
                    device_type,
                    backed_up,
                    created_at,
                    last_used_at
             FROM user_webauthn_credentials
             WHERE user_id = ?
             ORDER BY created_at DESC, id DESC`
        )
        .all(userId) as WebAuthnFactorSummaryRow[];
    const recovery = database
        .prepare(
            `SELECT COUNT(*) AS count
             FROM user_recovery_codes
             WHERE user_id = ? AND used_at IS NULL`
        )
        .get(userId) as { count: number };
    return {
        ...(user?.mfa_enabled_at && { enabledAt: user.mfa_enabled_at }),
        methods: mfaMethodsForUser(userId),
        recoveryCodesRemaining: recovery.count,
        totpFactors: totpFactors.map((factor) => ({
            confirmedAt: factor.confirmed_at,
            createdAt: factor.created_at,
            id: factor.id,
            label: factor.label,
        })),
        webAuthnCredentials: webAuthnCredentials.map((credential) => ({
            backedUp: credential.backed_up === 1,
            createdAt: credential.created_at,
            deviceType: credential.device_type,
            id: credential.id,
            label: credential.label,
            ...(credential.last_used_at && {
                lastUsedAt: credential.last_used_at,
            }),
        })),
    };
}

/** Removes all user-held factors and recovery codes after an explicit disable flow. */
export function disableMultiFactor(userId: number, now = new Date()): void {
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        database.prepare("DELETE FROM auth_pending_logins WHERE user_id = ?").run(userId);
        database
            .prepare("DELETE FROM auth_webauthn_challenges WHERE user_id = ?")
            .run(userId);
        database.prepare("DELETE FROM user_recovery_codes WHERE user_id = ?").run(userId);
        database.prepare("DELETE FROM user_totp_factors WHERE user_id = ?").run(userId);
        database
            .prepare("DELETE FROM user_webauthn_credentials WHERE user_id = ?")
            .run(userId);
        database
            .prepare(
                `UPDATE users
                 SET mfa_enabled_at = NULL, updated_at = ?
                 WHERE id = ?`
            )
            .run(timestamp, userId);
        database.run("COMMIT");
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "MFA disable and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Fails startup when stored TOTP data cannot be decrypted with the external key. */
export function validateTotpStorageConfig(): void {
    const factors = database
        .prepare(
            `SELECT id, user_id, encrypted_secret
             FROM user_totp_factors
             ORDER BY id`
        )
        .all() as Array<{
        encrypted_secret: string;
        id: string;
        user_id: number;
    }>;
    if (factors.length === 0) {
        return;
    }
    secretEncryptionKeyBytes();
    for (const factor of factors) {
        decryptStoredSecret(
            factor.encrypted_secret,
            totpAssociatedData(factor.user_id, factor.id)
        );
    }
}
