import { addMinutes, subMinutes } from "date-fns";
import { generate } from "otplib";
import * as v from "valibot";

import { users } from "../../../../database/schema/users.ts";
import {
    validUserInsert,
    validUserRecoveryCodeInsert,
    validUserTotpFactorInsert,
    validUserWebAuthnCredentialInsert,
} from "../../../../database/validation/testSupport/securityRows.ts";
import { userInsertSchema } from "../../../../database/validation/users.ts";
import {
    parseOpaqueToken,
    type ParsedOpaqueToken,
} from "../../../../shared/opaqueToken.ts";
import {
    createTestAuthenticationWorkGate,
    createTestGatewayWorkRuntime,
} from "../../../../test/support/authenticationWorkGate.ts";
import { openFreshMigratedDatabase } from "../../../../test/support/freshDatabase.ts";
import { testDashboardPasswordHash } from "../../../../test/support/securityPassword.ts";
import { createAuthenticationLifecycleService } from "../../authenticationLifecycle.ts";
import { createAuthenticationLifecycleRepository } from "../../authenticationLifecycleRepository.ts";
import {
    authenticationWorkBudgetMaximumUnits,
    authenticationWorkBudgetWindowMs,
    totpWorkBudgetMaximumUnits,
    totpWorkBudgetWindowMs,
} from "../../authenticationRateLimit.ts";
import {
    createAuthenticationWorkBudget,
    type AuthenticationWorkBudget,
} from "../../authenticationWorkBudget.ts";
import type { AuthenticationWorkGate } from "../../authenticationWorkGate.ts";
import { createMfaLifecycleRepository } from "../lifecycleRepository.ts";
import { createMfaLoginLifecycleService } from "../loginLifecycle.ts";
import type { MfaLoginWebAuthnDependencies } from "../loginLifecycleTypes.ts";
import {
    dashboardRecoveryCodeHashInput,
    parseDashboardRecoveryCode,
} from "../recoveryCodes.ts";
import type {
    EncryptedTotpSecret,
    TotpSecretCipher,
    TotpSecretStorageContext,
} from "../totpSecretCipher.ts";
import type { WebAuthnAdapter } from "../webauthn/adapter.ts";
import {
    ceremonyFixtureCredentialId,
    ceremonyFixturePublicKey,
} from "../webauthn/testSupport/ceremonyFixture.ts";

export const mfaLoginNow = new Date("2026-08-05T12:00:00.000Z");
export const mfaLoginUserId = validUserInsert.id;
export const mfaLoginTotpFactorId = validUserTotpFactorInsert.id;
export const mfaLoginUnavailableTotpFactorId = "019fc968-1a9b-7775-8f1b-d5b863b0e7b4";
export const mfaLoginRecoveryCodeSelector = validUserRecoveryCodeInsert.selector;
export const mfaLoginClientSourceId = "mfa-login-test-source";
export const mfaLoginRecoveryCode = `${mfaLoginRecoveryCodeSelector}-${"e".repeat(32)}`;

const totpSecret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const parsedRecoveryCode = parseDashboardRecoveryCode(mfaLoginRecoveryCode);
if (parsedRecoveryCode === undefined) {
    throw new Error("Recovery-code test fixture is invalid");
}
const expectedRecoveryHashInput = dashboardRecoveryCodeHashInput(
    mfaLoginUserId,
    parsedRecoveryCode
);

export function mfaLoginMetadata(
    requestId: string,
    clientSourceId = mfaLoginClientSourceId
) {
    return {
        clientSourceId,
        requestId,
        userAgent: "MFA login test browser",
    };
}

export function parsedPendingCredential(token: string): ParsedOpaqueToken {
    const credential = parseOpaqueToken(token, "pending-login");
    if (credential === undefined) {
        throw new Error("Pending-login service returned an invalid token");
    }
    return credential;
}

export async function mfaLoginTotpCodeAt(timestamp: Date): Promise<string> {
    return generate({
        algorithm: "sha1",
        digits: 6,
        epoch: Math.floor(timestamp.getTime() / 1000),
        period: 30,
        secret: totpSecret,
        strategy: "totp",
    });
}

export function createMfaLoginBarrier(participants: number) {
    if (!Number.isSafeInteger(participants) || participants < 1) {
        throw new RangeError("MFA login barrier size is invalid");
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

export interface MfaLoginHarnessOptions {
    readonly now?: () => Date;
    readonly passwordWorkGate?: AuthenticationWorkGate;
    readonly totpWorkBudget?: AuthenticationWorkBudget;
    readonly totpWorkGate?: AuthenticationWorkGate;
    readonly webAuthn?: MfaLoginWebAuthnDependencies;
}

export async function createMfaLoginHarness(options: MfaLoginHarnessOptions = {}) {
    const database = await openFreshMigratedDatabase();
    const repository = createMfaLifecycleRepository(database.orm);
    let beforeTotpDecrypt: (() => Promise<void> | void) | undefined;
    let passwordVerificationCalls = 0;
    const passwordCryptoTransactionStates: boolean[] = [];
    const recoveryCryptoTransactionStates: boolean[] = [];
    const totpCryptoTransactionStates: boolean[] = [];
    const webAuthnGenerationTransactionStates: boolean[] = [];
    const webAuthnVerificationTransactionStates: boolean[] = [];
    const webAuthn = options.webAuthn;

    try {
        database.orm
            .insert(users)
            .values(
                v.parse(userInsertSchema, {
                    ...validUserInsert,
                    createdAt: subMinutes(mfaLoginNow, 5),
                    mfaEnabledAt: mfaLoginNow,
                    updatedAt: mfaLoginNow,
                    username: "operator",
                })
            )
            .run();
        repository.withImmediateTransaction((unit) => {
            unit.insertTotpFactor({
                ...validUserTotpFactorInsert,
                confirmedAt: mfaLoginNow,
                createdAt: subMinutes(mfaLoginNow, 1),
                enrollmentExpiresAt: addMinutes(mfaLoginNow, 4),
                lastUsedStep: 0,
            });
            unit.insertRecoveryCode({
                ...validUserRecoveryCodeInsert,
                createdAt: mfaLoginNow,
            });
            if (webAuthn !== undefined) {
                unit.insertWebAuthnCredential({
                    ...validUserWebAuthnCredentialInsert,
                    backedUp: true,
                    createdAt: subMinutes(mfaLoginNow, 1),
                    credentialId: ceremonyFixtureCredentialId,
                    deviceType: "multiDevice",
                    publicKey: Buffer.from(ceremonyFixturePublicKey),
                    rpId: webAuthn.relyingParty.rpId,
                });
            }
        });

        const passwordWorkGate =
            options.passwordWorkGate ?? createTestAuthenticationWorkGate(1, 3);
        const passwordWorkBudget = createAuthenticationWorkBudget(
            authenticationWorkBudgetMaximumUnits,
            authenticationWorkBudgetWindowMs
        );
        const totpWorkGate =
            options.totpWorkGate ?? createTestAuthenticationWorkGate(2, 4);
        const totpWorkBudget =
            options.totpWorkBudget ??
            createAuthenticationWorkBudget(
                totpWorkBudgetMaximumUnits,
                totpWorkBudgetWindowMs
            );
        const totpSecretCipher: TotpSecretCipher = Object.freeze({
            activeKeyId: validUserTotpFactorInsert.secretKeyId,
            async decrypt(
                encrypted: EncryptedTotpSecret,
                context: TotpSecretStorageContext
            ) {
                totpCryptoTransactionStates.push(database.sqlite.inTransaction);
                if (
                    context.factorId === mfaLoginUnavailableTotpFactorId &&
                    context.userId === mfaLoginUserId &&
                    encrypted.envelope === validUserTotpFactorInsert.encryptedSecret &&
                    encrypted.keyId === validUserTotpFactorInsert.secretKeyId
                ) {
                    await beforeTotpDecrypt?.();
                    throw new Error("TOTP test factor is unavailable");
                }
                if (
                    encrypted.envelope !== validUserTotpFactorInsert.encryptedSecret ||
                    encrypted.keyId !== validUserTotpFactorInsert.secretKeyId ||
                    context.factorId !== mfaLoginTotpFactorId ||
                    context.userId !== mfaLoginUserId
                ) {
                    throw new Error("Unexpected TOTP cipher test context");
                }
                await beforeTotpDecrypt?.();
                return totpSecret;
            },
            encrypt: () => Promise.reject(new Error("TOTP encryption is not used here")),
            hasKey: (keyId: string) => keyId === validUserTotpFactorInsert.secretKeyId,
        });
        const webAuthnAdapter: WebAuthnAdapter | undefined =
            webAuthn === undefined
                ? undefined
                : Object.freeze({
                      generateAuthenticationOptions(
                          input: Parameters<
                              WebAuthnAdapter["generateAuthenticationOptions"]
                          >[0]
                      ) {
                          webAuthnGenerationTransactionStates.push(
                              database.sqlite.inTransaction
                          );
                          return webAuthn.adapter.generateAuthenticationOptions(input);
                      },
                      generateRegistrationOptions(
                          input: Parameters<
                              WebAuthnAdapter["generateRegistrationOptions"]
                          >[0]
                      ) {
                          return webAuthn.adapter.generateRegistrationOptions(input);
                      },
                      verifyAuthentication(
                          input: Parameters<WebAuthnAdapter["verifyAuthentication"]>[0]
                      ) {
                          webAuthnVerificationTransactionStates.push(
                              database.sqlite.inTransaction
                          );
                          return webAuthn.adapter.verifyAuthentication(input);
                      },
                      verifyRegistration(
                          input: Parameters<WebAuthnAdapter["verifyRegistration"]>[0]
                      ) {
                          return webAuthn.adapter.verifyRegistration(input);
                      },
                  });
        const service = createMfaLoginLifecycleService({
            now: options.now ?? (() => mfaLoginNow),
            passwordWorkBudget,
            passwordWorkGate,
            repository,
            totpSecretCipher,
            totpWorkBudget,
            totpWorkGate,
            verifyRecoveryCode: (hashInput, validatorHash) => {
                recoveryCryptoTransactionStates.push(database.sqlite.inTransaction);
                return Promise.resolve(
                    hashInput === expectedRecoveryHashInput &&
                        validatorHash === testDashboardPasswordHash
                );
            },
            ...(webAuthn === undefined
                ? {}
                : {
                      webAuthn: {
                          ...webAuthn,
                          adapter: webAuthnAdapter ?? webAuthn.adapter,
                      },
                  }),
        });
        const authenticationService = createAuthenticationLifecycleService({
            gatewayWorkRuntime: createTestGatewayWorkRuntime(),
            mfaLoginLifecycle: service,
            now: options.now ?? (() => mfaLoginNow),
            passwordWorkBudget,
            passwordWorkGate,
            repository: createAuthenticationLifecycleRepository(database.orm),
            verifyGatewayCredential: () => Promise.resolve(false),
            verifyPassword: (password) => {
                passwordVerificationCalls += 1;
                passwordCryptoTransactionStates.push(database.sqlite.inTransaction);
                return Promise.resolve(password === "correct-password-1");
            },
        });

        return {
            authenticationService,
            close: () => database.sqlite.close(true),
            database,
            passwordCryptoTransactionStates,
            passwordVerificationCalls: () => passwordVerificationCalls,
            recoveryCryptoTransactionStates,
            repository,
            service,
            insertUnavailableTotpFactor() {
                repository.withImmediateTransaction((unit) =>
                    unit.insertTotpFactor({
                        ...validUserTotpFactorInsert,
                        confirmedAt: mfaLoginNow,
                        createdAt: subMinutes(mfaLoginNow, 2),
                        enrollmentExpiresAt: addMinutes(mfaLoginNow, 3),
                        id: mfaLoginUnavailableTotpFactorId,
                        label: "Unavailable authenticator",
                        lastUsedStep: 0,
                    })
                );
            },
            setBeforeTotpDecrypt(callback: (() => Promise<void> | void) | undefined) {
                beforeTotpDecrypt = callback;
            },
            totpCryptoTransactionStates,
            webAuthnGenerationTransactionStates,
            webAuthnVerificationTransactionStates,
        };
    } catch (error) {
        database.sqlite.close(true);
        throw error;
    }
}

export async function beginPasswordMfaLogin(
    harness: Awaited<ReturnType<typeof createMfaLoginHarness>>,
    requestId: string
) {
    const result = await harness.authenticationService.login(
        { password: "correct-password-1", username: "operator" },
        mfaLoginMetadata(requestId)
    );
    if (result.status !== "mfa-required") {
        throw new Error(`Expected pending MFA login, received ${result.status}`);
    }
    return { ...result, credential: parsedPendingCredential(result.token) };
}

export function mfaLoginSessionCount(
    harness: Awaited<ReturnType<typeof createMfaLoginHarness>>
): number {
    return (
        harness.database.sqlite
            .query<{ count: number }, []>("SELECT count(*) AS count FROM auth_sessions")
            .get()?.count ?? -1
    );
}
