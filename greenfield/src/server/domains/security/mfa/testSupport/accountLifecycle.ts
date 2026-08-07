import { addMinutes, subMinutes } from "date-fns";
import * as v from "valibot";

import { recoveryCodeCount } from "../../../../../contracts/accountSecurity.ts";
import { users } from "../../../../database/schema/users.ts";
import {
    validAuthSessionInsert,
    validUserInsert,
} from "../../../../database/validation/testSupport/securityRows.ts";
import { userInsertSchema } from "../../../../database/validation/users.ts";
import { generateOpaqueToken } from "../../../../shared/opaqueToken.ts";
import { createTestAuthenticationWorkGate } from "../../../../test/support/authenticationWorkGate.ts";
import { testImmediateDatabaseWriteAdmission } from "../../../../test/support/databaseWriteAdmission.ts";
import { openFreshMigratedDatabase } from "../../../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../../../test/support/securityPassword.ts";
import type { AuthenticationWorkBudget } from "../../authenticationWorkBudget.ts";
import type {
    AuthenticationWorkGate,
    AuthenticationWorkRuntimeService,
} from "../../authenticationWorkGate.ts";
import { createMfaAccountLifecycleService } from "../accountLifecycle.ts";
import { createMfaLifecycleRepository } from "../lifecycleRepository.ts";
import {
    dashboardRecoveryCodeHashInput,
    type GeneratedRecoveryCode,
} from "../recoveryCodes.ts";
import type {
    EncryptedTotpSecret,
    TotpSecretCipher,
    TotpSecretStorageContext,
} from "../totpSecretCipher.ts";
import type { WebAuthnAdapter } from "../webauthn/adapter.ts";
import type { WebAuthnRelyingPartyConfiguration } from "../webauthn/relyingPartyConfiguration.ts";

export const accountLifecycleNow = new Date("2026-08-05T12:00:00.000Z");
export const accountLifecycleUserId = validUserInsert.id;
export const accountLifecycleInitialSessionId = validAuthSessionInsert.id;
export const accountLifecycleOtherSessionId = "f".repeat(32);
export const accountLifecycleUnavailableTotpFactorId =
    "019fc968-1a9b-7775-8f1b-d5b863b0e7b4";

const totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const encryptedSecret = `v1.${"A".repeat(16)}.${"B".repeat(64)}`;
const totpKeyId = "test-key";

export function accountLifecycleMetadata(requestId: string) {
    return {
        clientSourceId: "account-lifecycle-test-source",
        requestId,
        userAgent: "Account lifecycle test browser",
    };
}

export function createAccountLifecycleBarrier(participants: number) {
    if (!Number.isSafeInteger(participants) || participants < 1) {
        throw new RangeError("Account lifecycle barrier size is invalid");
    }
    let arrivals = 0;
    let release: (() => void) | undefined;
    const released = new Promise<void>((resolve) => {
        release = resolve;
    });
    return Object.freeze({
        arrivals: () => arrivals,
        async wait(): Promise<void> {
            arrivals += 1;
            if (arrivals === participants) release?.();
            await released;
        },
    });
}

function deterministicRecoveryCodes(
    userId: string,
    generation: number
): readonly GeneratedRecoveryCode[] {
    return Array.from({ length: recoveryCodeCount }, (_, index) => {
        const selector = (generation * recoveryCodeCount + index + 1)
            .toString(16)
            .padStart(32, "0");
        const validator = (generation * recoveryCodeCount + index + 101)
            .toString(16)
            .padStart(32, "0");
        return Object.freeze({
            code: `${selector}-${validator}`,
            selector,
            validatorHashInput: dashboardRecoveryCodeHashInput(userId, {
                selector,
                validator,
            }),
        });
    });
}

export interface AccountLifecycleHarnessOptions {
    readonly now?: () => Date;
    readonly passwordWorkGate?: AuthenticationWorkGate;
    readonly totpWorkGate?: AuthenticationWorkGate;
    readonly webAuthnAdapter?: WebAuthnAdapter;
    readonly webAuthnRelyingParty?: WebAuthnRelyingPartyConfiguration;
    readonly webAuthnVerificationTimeoutMs?: number;
    readonly webAuthnWorkBudget?: AuthenticationWorkBudget;
    readonly webAuthnWorkRuntime?: Pick<
        AuthenticationWorkRuntimeService,
        "runWebAuthnVerification"
    >;
}

export async function createAccountLifecycleHarness(
    options: AccountLifecycleHarnessOptions = {}
) {
    const database = await openFreshMigratedDatabase();
    const repository = createMfaLifecycleRepository(
        database.orm,
        testImmediateDatabaseWriteAdmission
    );
    const cryptoTransactionStates: boolean[] = [];
    const consumedWorkUnits: number[] = [];
    const consumedTotpWorkUnits: number[] = [];
    const hashedRecoveryInputs = new Set<string>();
    let activeRecoveryHashes = 0;
    let beforeTotpVerification: ((token: string) => Promise<void>) | undefined;
    let maximumConcurrentRecoveryHashes = 0;
    let passwordVerificationCalls = 0;
    let recoveryGeneration = 0;
    let recoveryVerificationCalls = 0;
    let totpDecryptionCalls = 0;

    try {
        database.orm
            .insert(users)
            .values(
                v.parse(userInsertSchema, {
                    ...validUserInsert,
                    createdAt: subMinutes(accountLifecycleNow, 5),
                    updatedAt: subMinutes(accountLifecycleNow, 4),
                    username: "operator",
                })
            )
            .run();
        await repository.withImmediateTransaction((unit) => {
            unit.insertSession({
                ...validAuthSessionInsert,
                authenticatedAt: subMinutes(accountLifecycleNow, 5),
                createdAt: accountLifecycleNow,
                expiresAt: addMinutes(accountLifecycleNow, 30),
                lastSeenAt: accountLifecycleNow,
                passwordVerifiedAt: accountLifecycleNow,
                userAgent: "Initial test browser",
            });
            unit.insertSession({
                ...validAuthSessionInsert,
                authenticatedAt: subMinutes(accountLifecycleNow, 5),
                createdAt: accountLifecycleNow,
                expiresAt: addMinutes(accountLifecycleNow, 30),
                id: accountLifecycleOtherSessionId,
                lastSeenAt: accountLifecycleNow,
                passwordVerifiedAt: accountLifecycleNow,
                validatorHash: "e".repeat(64),
            });
        });

        const observeCrypto = (): void => {
            cryptoTransactionStates.push(database.sqlite.inTransaction);
        };
        const totpSecretCipher: TotpSecretCipher = Object.freeze({
            activeKeyId: totpKeyId,
            decrypt: (
                _encrypted: EncryptedTotpSecret,
                context: TotpSecretStorageContext
            ) => {
                observeCrypto();
                totpDecryptionCalls += 1;
                if (context.factorId === accountLifecycleUnavailableTotpFactorId) {
                    return Promise.reject(new Error("TOTP test factor is unavailable"));
                }
                return Promise.resolve(totpSecret);
            },
            encrypt: () => {
                observeCrypto();
                return Promise.resolve({ envelope: encryptedSecret, keyId: totpKeyId });
            },
            hasKey: (keyId: string) => keyId === totpKeyId,
        });
        const service = createMfaAccountLifecycleService({
            generateId: () => Bun.randomUUIDv7(),
            generateRecoveryCodes: (recoveryUserId) =>
                deterministicRecoveryCodes(recoveryUserId, recoveryGeneration++),
            generateSessionToken: () => generateOpaqueToken("session"),
            generateTotpSecret: () => totpSecret,
            hashRecoveryCode: async (hashInput) => {
                observeCrypto();
                activeRecoveryHashes += 1;
                maximumConcurrentRecoveryHashes = Math.max(
                    maximumConcurrentRecoveryHashes,
                    activeRecoveryHashes
                );
                await Promise.resolve();
                hashedRecoveryInputs.add(hashInput);
                activeRecoveryHashes -= 1;
                return testDashboardPasswordHash;
            },
            now: options.now ?? (() => accountLifecycleNow),
            passwordWorkBudget: Object.freeze({
                consume(units = 1) {
                    consumedWorkUnits.push(units);
                    return { accepted: true as const };
                },
            }),
            passwordWorkGate:
                options.passwordWorkGate ?? createTestAuthenticationWorkGate(16, 16),
            repository,
            totpSecretCipher,
            totpWorkBudget: Object.freeze({
                consume(units = 1) {
                    consumedTotpWorkUnits.push(units);
                    return { accepted: true as const };
                },
            }),
            totpWorkGate:
                options.totpWorkGate ?? createTestAuthenticationWorkGate(16, 16),
            verifyPassword: (password, hash) => {
                observeCrypto();
                passwordVerificationCalls += 1;
                return Promise.resolve(
                    password === "correct-password-1" &&
                        hash === testDashboardPasswordHash
                );
            },
            verifyRecoveryCode: (hashInput, hash) => {
                observeCrypto();
                recoveryVerificationCalls += 1;
                return Promise.resolve(
                    hash === testDashboardPasswordHash &&
                        hashedRecoveryInputs.has(hashInput)
                );
            },
            verifyTotp: async ({ lastUsedTimeStep, secret, token }) => {
                observeCrypto();
                await beforeTotpVerification?.(token);
                return secret === totpSecret && token === "123456"
                    ? { timeStep: (lastUsedTimeStep ?? 100) + 1 }
                    : undefined;
            },
            ...(options.webAuthnAdapter === undefined
                ? {}
                : { webAuthnAdapter: options.webAuthnAdapter }),
            ...(options.webAuthnRelyingParty === undefined
                ? {}
                : { webAuthnRelyingParty: options.webAuthnRelyingParty }),
            ...(options.webAuthnVerificationTimeoutMs === undefined
                ? {}
                : {
                      webAuthnVerificationTimeoutMs:
                          options.webAuthnVerificationTimeoutMs,
                  }),
            ...(options.webAuthnWorkBudget === undefined
                ? {}
                : { webAuthnWorkBudget: options.webAuthnWorkBudget }),
            ...(options.webAuthnWorkRuntime === undefined
                ? {}
                : { webAuthnWorkRuntime: options.webAuthnWorkRuntime }),
        });

        return {
            close: () => database.sqlite.close(true),
            cryptoTransactionStates,
            database,
            consumedWorkUnits,
            consumedTotpWorkUnits,
            async insertUnavailableTotpFactor() {
                await repository.withImmediateTransaction((unit) =>
                    unit.insertTotpFactor({
                        confirmedAt: accountLifecycleNow,
                        createdAt: subMinutes(accountLifecycleNow, 1),
                        encryptedSecret,
                        enrollmentExpiresAt: addMinutes(accountLifecycleNow, 4),
                        id: accountLifecycleUnavailableTotpFactorId,
                        label: "Unavailable authenticator",
                        lastUsedStep: 0,
                        secretKeyId: totpKeyId,
                        userId: accountLifecycleUserId,
                    })
                );
            },
            maximumConcurrentRecoveryHashes: () => maximumConcurrentRecoveryHashes,
            passwordVerificationCalls: () => passwordVerificationCalls,
            recoveryVerificationCalls: () => recoveryVerificationCalls,
            repository,
            service,
            setBeforeTotpVerification(
                callback: ((token: string) => Promise<void>) | undefined
            ) {
                beforeTotpVerification = callback;
            },
            totpDecryptionCalls: () => totpDecryptionCalls,
        };
    } catch (error) {
        database.sqlite.close(true);
        throw error;
    }
}

export async function enableAccountMfa(
    harness: Awaited<ReturnType<typeof createAccountLifecycleHarness>>
) {
    const identity = {
        sessionId: accountLifecycleInitialSessionId,
        userId: accountLifecycleUserId,
    };
    const enrollment = await harness.service.beginTotpEnrollment(
        identity,
        { label: "Primary authenticator" },
        accountLifecycleMetadata("begin-primary")
    );
    if (enrollment.status !== "created") {
        throw new Error(`Expected TOTP enrollment, received ${enrollment.status}`);
    }
    const confirmed = await harness.service.confirmTotpEnrollment(
        identity,
        { code: "123456", factorId: enrollment.enrollment.factorId },
        accountLifecycleMetadata("confirm-primary")
    );
    if (confirmed.status !== "confirmed" || !confirmed.enabledNow) {
        throw new Error(
            `Expected first-factor confirmation, received ${confirmed.status}`
        );
    }
    return {
        confirmed,
        factorId: enrollment.enrollment.factorId,
        identity: { sessionId: confirmed.session.id, userId: accountLifecycleUserId },
    };
}
