import { generateSecret, generateURI, verify } from "otplib";
import * as v from "valibot";

import { securityUsernameSchema } from "../../../../contracts/security.ts";

const totpSecretPattern = /^[A-Z2-7]{32}$/u;
const totpCodePattern = /^\d{6}$/u;

/** Fixed authenticator-app policy supported by the Dashboard. */
export const dashboardTotpPolicy = Object.freeze({
    algorithm: "sha1" as const,
    digits: 6 as const,
    issuer: "Mira Dashboard",
    periodSeconds: 30,
    t0Seconds: 0,
});

export interface TotpVerificationResult {
    readonly timeStep: number;
}

export interface TotpVerificationAtEpochInput {
    readonly epochSeconds: number;
    readonly secret: string;
    readonly token: string;
}

export type VerifyTotpAtEpoch = (
    input: TotpVerificationAtEpochInput
) => Promise<
    { readonly valid: false } | { readonly timeStep: number; readonly valid: true }
>;

async function verifyWithOtplib(
    input: TotpVerificationAtEpochInput
): ReturnType<VerifyTotpAtEpoch> {
    const result = await verify({
        algorithm: dashboardTotpPolicy.algorithm,
        digits: dashboardTotpPolicy.digits,
        epoch: input.epochSeconds,
        epochTolerance: 0,
        period: dashboardTotpPolicy.periodSeconds,
        secret: input.secret,
        strategy: "totp",
        t0: dashboardTotpPolicy.t0Seconds,
        token: input.token,
    });
    return result.valid && "timeStep" in result
        ? { timeStep: result.timeStep, valid: true }
        : { valid: false };
}

/**
 * Returns whether a decrypted TOTP seed is the canonical 160-bit Base32 form.
 * @param value Untrusted candidate TOTP seed.
 * @returns Whether the value is a canonical uppercase, unpadded Base32 seed.
 */
export function isCanonicalTotpSecret(value: unknown): value is string {
    return typeof value === "string" && totpSecretPattern.test(value);
}

/**
 * Generates one canonical 160-bit TOTP seed using otplib's pinned plugins.
 * @returns Uppercase, unpadded Base32 seed exposed only during enrollment.
 */
export function generateDashboardTotpSecret(): string {
    const secret = generateSecret({ length: 20 });
    if (!isCanonicalTotpSecret(secret)) {
        throw new Error("otplib returned an unsupported TOTP secret");
    }
    return secret;
}

/**
 * Builds the exact authenticator-app provisioning URI for one operator.
 * @param username Canonical Dashboard username shown by the authenticator app.
 * @param secret Canonical enrollment seed returned only once.
 * @returns TOTP otpauth URI containing the enrollment seed.
 */
export function createDashboardTotpUri(username: string, secret: string): string {
    if (
        !v.safeParse(securityUsernameSchema, username, { abortEarly: true }).success ||
        !isCanonicalTotpSecret(secret)
    ) {
        throw new TypeError("TOTP provisioning input is invalid");
    }
    return generateURI({
        algorithm: dashboardTotpPolicy.algorithm,
        digits: dashboardTotpPolicy.digits,
        issuer: dashboardTotpPolicy.issuer,
        label: username,
        period: dashboardTotpPolicy.periodSeconds,
        secret,
        strategy: "totp",
    });
}

export interface VerifyDashboardTotpInput {
    readonly lastUsedTimeStep?: number | null;
    readonly now: Date;
    readonly secret: string;
    readonly token: string;
}

/**
 * Verifies the current TOTP step before the immediately previous step.
 * This avoids otplib's past-first tolerance scan allowing a colliding visible
 * token to match the prior step first and then the current step on replay.
 * @param input Canonical seed, six-digit token, replay floor, and injected time.
 * @param verifyAtEpoch Injectable single-step verifier for deterministic tests.
 * @returns Matched time step, or undefined for an invalid/replayed token.
 */
export async function verifyDashboardTotp(
    input: VerifyDashboardTotpInput,
    verifyAtEpoch: VerifyTotpAtEpoch = verifyWithOtplib
): Promise<TotpVerificationResult | undefined> {
    const nowMs = input.now.getTime();
    if (!Number.isFinite(nowMs) || nowMs < 0) {
        throw new RangeError("TOTP verification time is invalid");
    }
    if (
        input.lastUsedTimeStep != null &&
        (!Number.isSafeInteger(input.lastUsedTimeStep) || input.lastUsedTimeStep < 0)
    ) {
        throw new RangeError("TOTP replay state is invalid");
    }
    if (!isCanonicalTotpSecret(input.secret) || !totpCodePattern.test(input.token)) {
        return undefined;
    }

    const epochSeconds = Math.floor(nowMs / 1000);
    const currentTimeStep = Math.floor(epochSeconds / dashboardTotpPolicy.periodSeconds);
    const candidateTimeSteps = [currentTimeStep, currentTimeStep - 1];
    for (const timeStep of candidateTimeSteps) {
        if (
            timeStep < 0 ||
            (input.lastUsedTimeStep != null && timeStep <= input.lastUsedTimeStep)
        ) {
            continue;
        }
        const result = await verifyAtEpoch({
            epochSeconds: timeStep * dashboardTotpPolicy.periodSeconds,
            secret: input.secret,
            token: input.token,
        });
        if (!result.valid) continue;
        if (result.timeStep !== timeStep) {
            throw new Error("TOTP verifier returned an inconsistent time step");
        }
        return Object.freeze({ timeStep });
    }
    return undefined;
}
