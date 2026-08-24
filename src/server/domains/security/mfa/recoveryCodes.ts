import * as v from "valibot";

import { securityRecordIdSchema } from "../../../../contracts/security.ts";
import { randomHex } from "../../../shared/crypto.ts";

const recoveryCodeSelectorByteLength = 16;
const recoveryCodeValidatorByteLength = 16;
const recoveryCodeMaximumRawLength = 128;
const recoveryCodePattern = /^([0-9a-f]{32})-([0-9a-f]{32})$/u;
const recoveryCodePartPattern = /^[0-9a-f]{32}$/u;
const recoveryCodeGenerationAttemptMaximum = 40;

/** Number of recovery codes installed as one atomic set. */
export const dashboardRecoveryCodeCount = 10;

/** Secret material parsed from one canonical recovery code. */
export interface ParsedRecoveryCode {
    readonly selector: string;
    readonly validator: string;
}

/** Plaintext returned once plus the preimage that must be Argon2id-hashed. */
export interface GeneratedRecoveryCode {
    readonly code: string;
    readonly selector: string;
    readonly validatorHashInput: string;
}

export interface RecoveryCodeGenerationOptions {
    readonly randomHex?: (byteLength: number) => string;
}

/**
 * Parses copy/pasted recovery input without accepting ambiguous internal syntax.
 * @param value Untrusted recovery code candidate.
 * @returns Canonical selector and validator, or undefined when malformed.
 */
export function parseDashboardRecoveryCode(
    value: unknown
): ParsedRecoveryCode | undefined {
    if (typeof value !== "string" || value.length > recoveryCodeMaximumRawLength) {
        return undefined;
    }
    const match = value.trim().toLowerCase().match(recoveryCodePattern);
    const selector = match?.[1];
    const validator = match?.[2];
    return selector === undefined || validator === undefined
        ? undefined
        : Object.freeze({ selector, validator });
}

/**
 * Binds one random recovery validator to its stable user and selector context.
 * @param userId Canonical user UUIDv7.
 * @param recoveryCode Canonical selector and validator.
 * @returns Fixed domain-separated preimage for the reviewed Argon2id policy.
 */
export function dashboardRecoveryCodeHashInput(
    userId: string,
    recoveryCode: ParsedRecoveryCode
): string {
    if (
        !v.safeParse(securityRecordIdSchema, userId, { abortEarly: true }).success ||
        !recoveryCodePartPattern.test(recoveryCode.selector) ||
        !recoveryCodePartPattern.test(recoveryCode.validator)
    ) {
        throw new TypeError("Recovery code hash context is invalid");
    }
    return `mira-dashboard:recovery-code:v1:user:${userId}:selector:${recoveryCode.selector}:validator:${recoveryCode.validator}`;
}

/**
 * Generates ten unique 128-bit-selector/128-bit-validator recovery codes.
 * Hashing is deliberately left to the caller so all ten Argon2id operations
 * can reserve the shared work budget once and execute sequentially under the
 * process-wide authentication gate.
 * @param userId Canonical user UUIDv7 bound into every hash preimage.
 * @param options Injectable secure random source for deterministic tests.
 * @returns One-time plaintext codes and their sensitive Argon2id preimages.
 */
export function generateDashboardRecoveryCodes(
    userId: string,
    options: RecoveryCodeGenerationOptions = {}
): readonly GeneratedRecoveryCode[] {
    if (!v.safeParse(securityRecordIdSchema, userId, { abortEarly: true }).success) {
        throw new TypeError("Recovery code user is invalid");
    }
    const generateRandomHex = options.randomHex ?? randomHex;
    const generated: GeneratedRecoveryCode[] = [];
    const selectors = new Set<string>();
    let attempts = 0;

    while (
        generated.length < dashboardRecoveryCodeCount &&
        attempts < recoveryCodeGenerationAttemptMaximum
    ) {
        attempts += 1;
        const selector = generateRandomHex(recoveryCodeSelectorByteLength);
        if (!recoveryCodePartPattern.test(selector)) {
            throw new Error("Recovery code randomness is invalid");
        }
        if (selectors.has(selector)) continue;

        const validator = generateRandomHex(recoveryCodeValidatorByteLength);
        if (!recoveryCodePartPattern.test(validator)) {
            throw new Error("Recovery code randomness is invalid");
        }
        const parsed = Object.freeze({ selector, validator });
        selectors.add(selector);
        generated.push(
            Object.freeze({
                code: `${selector}-${validator}`,
                selector,
                validatorHashInput: dashboardRecoveryCodeHashInput(userId, parsed),
            })
        );
    }

    if (generated.length !== dashboardRecoveryCodeCount) {
        throw new Error("Recovery code selectors could not be generated uniquely");
    }
    return Object.freeze(generated);
}
