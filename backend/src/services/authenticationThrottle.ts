import { database, sqlNullable } from "../database.ts";
import { sha256Hex } from "./mfaCrypto.ts";

const FAILURE_WINDOW_MS = 60 * 60_000;
const STALE_BUCKET_MS = 24 * 60 * 60_000;

const BLOCK_DURATIONS = [
    { failures: 10, milliseconds: 15 * 60_000 },
    { failures: 8, milliseconds: 5 * 60_000 },
    { failures: 5, milliseconds: 60_000 },
    { failures: 3, milliseconds: 15_000 },
] as const;

export type AuthenticationThrottleKind =
    "account-password" | "login-password" | "second-factor";

interface AuthenticationThrottleRow {
    blocked_until: string | null;
    failure_count: number;
    first_failed_at: string;
}

export interface AuthenticationThrottleStatus {
    allowed: boolean;
    retryAfterSeconds?: number;
}

function nowIso(now: Date): string {
    return now.toISOString();
}

function bucketKey(kind: AuthenticationThrottleKind, subject: number | string): string {
    return sha256Hex(`mira-dashboard:auth-throttle:v1:${kind}:${subject}`);
}

function blockDurationMs(failureCount: number): number {
    return (
        BLOCK_DURATIONS.find(({ failures }) => failureCount >= failures)?.milliseconds ??
        0
    );
}

/** Returns whether the account-scoped authentication bucket may be attempted. */
export function authenticationThrottleStatus(
    kind: AuthenticationThrottleKind,
    subject: number | string,
    now = new Date()
): AuthenticationThrottleStatus {
    const row = database
        .prepare(
            `SELECT failure_count, first_failed_at, blocked_until
             FROM auth_rate_limit_buckets
             WHERE bucket_key = ?`
        )
        .get(bucketKey(kind, subject)) as AuthenticationThrottleRow | undefined;
    if (!row?.blocked_until) {
        return { allowed: true };
    }
    const blockedUntil = Date.parse(row.blocked_until);
    if (!Number.isFinite(blockedUntil) || blockedUntil <= now.getTime()) {
        return { allowed: true };
    }
    return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - now.getTime()) / 1000)),
    };
}

/** Records one failed authentication attempt and applies progressive cooldowns. */
export function recordAuthenticationFailure(
    kind: AuthenticationThrottleKind,
    subject: number | string,
    now = new Date()
): AuthenticationThrottleStatus {
    const key = bucketKey(kind, subject);
    const timestamp = nowIso(now);
    database.run("BEGIN IMMEDIATE");
    try {
        const row = database
            .prepare(
                `SELECT failure_count, first_failed_at, blocked_until
                 FROM auth_rate_limit_buckets
                 WHERE bucket_key = ?`
            )
            .get(key) as AuthenticationThrottleRow | undefined;
        const firstFailedAt = row ? Date.parse(row.first_failed_at) : NaN;
        const isCurrentWindow =
            Number.isFinite(firstFailedAt) &&
            firstFailedAt <= now.getTime() &&
            now.getTime() - firstFailedAt <= FAILURE_WINDOW_MS;
        const failureCount = isCurrentWindow ? (row?.failure_count ?? 0) + 1 : 1;
        const durationMs = blockDurationMs(failureCount);
        const blockedUntil =
            durationMs > 0
                ? new Date(now.getTime() + durationMs).toISOString()
                : undefined;
        database
            .prepare(
                `INSERT INTO auth_rate_limit_buckets (
                    bucket_key,
                    failure_count,
                    first_failed_at,
                    blocked_until,
                    updated_at
                 ) VALUES (?, ?, ?, ?, ?)
                 ON CONFLICT(bucket_key) DO UPDATE
                 SET failure_count = excluded.failure_count,
                     first_failed_at = excluded.first_failed_at,
                     blocked_until = excluded.blocked_until,
                     updated_at = excluded.updated_at`
            )
            .run(
                key,
                failureCount,
                isCurrentWindow && row ? row.first_failed_at : timestamp,
                sqlNullable(blockedUntil),
                timestamp
            );
        database.run("COMMIT");
        return blockedUntil
            ? {
                  allowed: false,
                  retryAfterSeconds: Math.ceil(durationMs / 1000),
              }
            : { allowed: true };
    } catch (error) {
        try {
            database.run("ROLLBACK");
        } catch (rollbackError) {
            throw new AggregateError(
                [error, rollbackError],
                "Authentication throttle update and rollback failed",
                { cause: rollbackError }
            );
        }
        throw error;
    }
}

/** Clears a failure bucket after successful authentication. */
export function clearAuthenticationFailures(
    kind: AuthenticationThrottleKind,
    subject: number | string
): void {
    database
        .prepare("DELETE FROM auth_rate_limit_buckets WHERE bucket_key = ?")
        .run(bucketKey(kind, subject));
}

/** Removes old throttle state after its failure window and cooldown are over. */
export function cleanupAuthenticationThrottleState(now = new Date()): number {
    return database
        .prepare(
            `DELETE FROM auth_rate_limit_buckets
             WHERE updated_at <= ?
               AND (blocked_until IS NULL OR blocked_until <= ?)`
        )
        .run(new Date(now.getTime() - STALE_BUCKET_MS).toISOString(), nowIso(now))
        .changes;
}
