import {
    addMilliseconds,
    compareAsc,
    differenceInMilliseconds,
    hoursToMilliseconds,
    minutesToMilliseconds,
} from "date-fns";

import type { AuthenticationRateLimitKind } from "../../database/schema/authRateLimitBuckets.ts";
import { sha256Hex } from "../../shared/crypto.ts";
import type {
    AuthenticationRateLimitReader,
    AuthenticationRateLimitUnitOfWork,
    AuthRateLimitBucket,
} from "./securityPersistenceTypes.ts";

export type {
    AuthenticationRateLimitReader,
    AuthenticationRateLimitUnitOfWork,
} from "./securityPersistenceTypes.ts";

const rateLimitFailureWindowMs = hoursToMilliseconds(1);
const sourceRateLimitBucketMaximum = 256;
const sourceRateLimitBucketRetentionMs = hoursToMilliseconds(24);

export const saturatedAuthenticationRetryAfterSeconds = 1;
export const authenticationWorkBudgetMaximumUnits = 30;
export const authenticationWorkBudgetWindowMs = minutesToMilliseconds(1);
/** Bounds aggregate AES/HMAC TOTP checks before durable failure cooldowns engage. */
export const totpWorkBudgetMaximumUnits = 60;
export const totpWorkBudgetWindowMs = minutesToMilliseconds(1);
/** Bounds aggregate WebAuthn parsing and signature verification work. */
export const webAuthnWorkBudgetMaximumUnits = 60;
export const webAuthnWorkBudgetWindowMs = minutesToMilliseconds(1);

export const sourceRateLimitBlockDurations = [
    { failures: 10, milliseconds: minutesToMilliseconds(15) },
    { failures: 8, milliseconds: minutesToMilliseconds(5) },
    { failures: 5, milliseconds: minutesToMilliseconds(1) },
    { failures: 3, milliseconds: 15_000 },
] as const;

export const globalRateLimitBlockDurations = [
    { failures: 50, milliseconds: minutesToMilliseconds(15) },
    { failures: 40, milliseconds: minutesToMilliseconds(5) },
    { failures: 30, milliseconds: minutesToMilliseconds(1) },
    { failures: 20, milliseconds: 15_000 },
] as const;

export interface AuthenticationRateLimitTarget {
    readonly blockDurations: readonly {
        readonly failures: number;
        readonly milliseconds: number;
    }[];
    readonly kind: AuthenticationRateLimitKind;
    readonly sourceScoped?: boolean;
    readonly subject: string;
}

function blockDurationMs(
    failureCount: number,
    blockDurations: AuthenticationRateLimitTarget["blockDurations"]
): number {
    let longestDuration = 0;
    for (const { failures, milliseconds } of blockDurations) {
        if (failureCount >= failures) {
            longestDuration = Math.max(longestDuration, milliseconds);
        }
    }
    return longestDuration;
}

function retryAfterSeconds(blockedUntil: Date, now: Date): number {
    return Math.max(1, Math.ceil(differenceInMilliseconds(blockedUntil, now) / 1000));
}

export function rateLimitBucketKey(
    kind: AuthenticationRateLimitKind,
    subject: string
): string {
    return sha256Hex(`mira-dashboard:auth-rate-limit:v1:${kind}:${subject}`);
}

function activeRateLimit(
    bucket: AuthRateLimitBucket | undefined,
    now: Date
): { readonly retryAfterSeconds: number } | undefined {
    return bucket?.blockedUntil !== null &&
        bucket?.blockedUntil !== undefined &&
        compareAsc(bucket.blockedUntil, now) > 0
        ? { retryAfterSeconds: retryAfterSeconds(bucket.blockedUntil, now) }
        : undefined;
}

export function activeRateLimitForTargets(
    reader: AuthenticationRateLimitReader,
    targets: readonly AuthenticationRateLimitTarget[],
    now: Date
): { readonly retryAfterSeconds: number } | undefined {
    let longestRetryAfterSeconds = 0;
    for (const target of targets) {
        const active = activeRateLimit(
            reader.findRateLimitBucket(rateLimitBucketKey(target.kind, target.subject)),
            now
        );
        longestRetryAfterSeconds = Math.max(
            longestRetryAfterSeconds,
            active?.retryAfterSeconds ?? 0
        );
    }
    return longestRetryAfterSeconds === 0
        ? undefined
        : { retryAfterSeconds: longestRetryAfterSeconds };
}

function recordAuthenticationFailure(
    unit: AuthenticationRateLimitUnitOfWork,
    target: AuthenticationRateLimitTarget,
    now: Date
): { readonly retryAfterSeconds?: number } {
    const bucketKey = rateLimitBucketKey(target.kind, target.subject);
    const existing = unit.findRateLimitBucket(bucketKey);
    const firstFailureAge =
        existing === undefined
            ? -1
            : differenceInMilliseconds(now, existing.firstFailedAt);
    const continuesWindow =
        existing !== undefined &&
        firstFailureAge >= 0 &&
        firstFailureAge <= rateLimitFailureWindowMs;
    const failureCount = continuesWindow
        ? Math.min(Number.MAX_SAFE_INTEGER, existing.failureCount + 1)
        : 1;
    const durationMs = blockDurationMs(failureCount, target.blockDurations);
    const blockedUntil = durationMs === 0 ? null : addMilliseconds(now, durationMs);
    unit.upsertRateLimitBucket({
        blockedUntil,
        bucketKey,
        failureCount,
        firstFailedAt: continuesWindow && existing ? existing.firstFailedAt : now,
        kind: target.kind,
        updatedAt: now,
    });
    if (target.sourceScoped === true) {
        unit.pruneRateLimitBuckets({
            kind: target.kind,
            maximumBuckets: sourceRateLimitBucketMaximum,
            retainedBucketKey: bucketKey,
            staleBefore: addMilliseconds(now, -sourceRateLimitBucketRetentionMs),
        });
    }
    return blockedUntil === null
        ? {}
        : { retryAfterSeconds: retryAfterSeconds(blockedUntil, now) };
}

export function recordAuthenticationFailures(
    unit: AuthenticationRateLimitUnitOfWork,
    targets: readonly AuthenticationRateLimitTarget[],
    now: Date
): { readonly retryAfterSeconds?: number } {
    let longestRetryAfterSeconds = 0;
    for (const target of targets) {
        const recorded = recordAuthenticationFailure(unit, target, now);
        longestRetryAfterSeconds = Math.max(
            longestRetryAfterSeconds,
            recorded.retryAfterSeconds ?? 0
        );
    }
    return longestRetryAfterSeconds === 0
        ? {}
        : { retryAfterSeconds: longestRetryAfterSeconds };
}
