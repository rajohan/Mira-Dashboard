import { recoveryCodeCount } from "../../../../contracts/accountSecurity.ts";
import type { AuthenticationMethod } from "../../../../contracts/security.ts";
import {
    generateOpaqueToken,
    type GeneratedOpaqueToken,
} from "../../../shared/opaqueToken.ts";
import { createSecurityAuditEvent, type SecurityAuditEventInput } from "../audit.ts";
import {
    browserSessionIdleDurationDefaultMs,
    browserSessionIdleDurationMaximumMs,
    browserSessionIdleDurationMinimumMs,
} from "../authenticationPolicy.ts";
import {
    insertBrowserSession,
    type AuthenticatedBrowserIdentity,
} from "../authenticationSession.ts";
import type { AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import type { AuthenticationWorkGate } from "../authenticationWorkGate.ts";
import { hashDashboardPassword, verifyDashboardPassword } from "../password.ts";
import {
    recentAuthenticationWindowDefaultMs,
    recentAuthenticationWindowMaximumMs,
    recentAuthenticationWindowMinimumMs,
} from "../recentAuthentication.ts";
import {
    createAccountLifecycleCryptoHelpers,
    type AccountLifecycleCryptoHelpers,
} from "./accountLifecycleCrypto.ts";
import {
    activeAccount,
    MfaAccountSessionChangedError,
    type AccountSnapshot,
} from "./accountLifecycleState.ts";
import type { MfaAccountLifecycleDependencies } from "./accountLifecycleTypes.ts";
import type {
    MfaLifecycleRepository,
    MfaLifecycleUnitOfWork,
    MfaSessionRecord,
    MfaUserRecord,
} from "./lifecycleRepositoryTypes.ts";
import {
    dashboardRecoveryCodeCount,
    generateDashboardRecoveryCodes,
} from "./recoveryCodes.ts";
import {
    generateDashboardTotpSecret,
    verifyDashboardTotp,
    type TotpVerificationResult,
    type VerifyDashboardTotpInput,
} from "./totp.ts";
import type { TotpSecretCipher } from "./totpSecretCipher.ts";

export interface RotatedSession {
    readonly record: MfaSessionRecord;
    readonly token: string;
}

export interface MfaAccountLifecycleContext extends AccountLifecycleCryptoHelpers {
    readonly audit: (
        unit: MfaLifecycleUnitOfWork,
        input: Omit<SecurityAuditEventInput, "id">
    ) => void;
    readonly generateId: () => string;
    readonly generateSessionToken: () => GeneratedOpaqueToken;
    readonly generateTotpSecret: () => string;
    readonly now: () => Date;
    readonly passwordWorkBudget: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly readActiveAccount: (
        identity: AuthenticatedBrowserIdentity,
        checkedAt: Date
    ) => AccountSnapshot | undefined;
    readonly recentAuthenticationWindowMs: number;
    readonly repository: MfaLifecycleRepository;
    readonly rotateSession: (
        unit: MfaLifecycleUnitOfWork,
        account: AccountSnapshot,
        user: MfaUserRecord,
        token: GeneratedOpaqueToken,
        input: {
            readonly authenticationMethod: AuthenticationMethod;
            readonly createdAt: Date;
            readonly mfaVerifiedAt: Date | null;
            readonly passwordVerifiedAt: Date;
            readonly userAgent?: string;
        }
    ) => RotatedSession;
    readonly sessionIdleDurationMs: number;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly totpWorkBudget: AuthenticationWorkBudget;
    readonly totpWorkGate: AuthenticationWorkGate;
    readonly verifyPassword: (password: string, hash: string) => Promise<boolean>;
    readonly verifyRecoveryCode: (
        hashInput: string,
        validatorHash: string
    ) => Promise<boolean>;
    readonly verifyTotp: (
        input: VerifyDashboardTotpInput
    ) => Promise<TotpVerificationResult | undefined>;
}

const rotateSession: MfaAccountLifecycleContext["rotateSession"] = (
    unit,
    account,
    user,
    token,
    input
) => {
    const removed = unit.deleteSessionForRotation({
        expectedAuthenticationVersion: account.session.authenticationVersion,
        expectedValidatorHash: account.session.validatorHash,
        sessionId: account.session.id,
        userId: account.user.id,
    });
    if (removed === undefined) throw new MfaAccountSessionChangedError();
    const record = insertBrowserSession(unit, {
        authenticatedAt: account.session.authenticatedAt,
        authenticationMethod: input.authenticationMethod,
        createdAt: input.createdAt,
        expiresAt: account.session.expiresAt,
        mfaVerifiedAt: input.mfaVerifiedAt,
        passwordVerifiedAt: input.passwordVerifiedAt,
        token,
        user,
        userAgent: input.userAgent ?? account.session.userAgent ?? undefined,
    });
    return { record, token: token.token };
};

/**
 * Builds validated dependency policy, audit, and session-rotation context.
 * @returns Frozen context consumed by the focused account lifecycle operations.
 */
export function createMfaAccountLifecycleContext(
    dependencies: MfaAccountLifecycleDependencies
): MfaAccountLifecycleContext {
    if (dashboardRecoveryCodeCount !== recoveryCodeCount) {
        throw new Error("Recovery-code policy constants are inconsistent");
    }
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const generateRecoveryCodes =
        dependencies.generateRecoveryCodes ?? generateDashboardRecoveryCodes;
    const generateSessionToken =
        dependencies.generateSessionToken ?? (() => generateOpaqueToken("session"));
    const generateTotpSecret =
        dependencies.generateTotpSecret ?? generateDashboardTotpSecret;
    const hashRecoveryCode = dependencies.hashRecoveryCode ?? hashDashboardPassword;
    const verifyPassword = dependencies.verifyPassword ?? verifyDashboardPassword;
    const verifyRecoveryCode = dependencies.verifyRecoveryCode ?? verifyDashboardPassword;
    const verifyTotp = dependencies.verifyTotp ?? verifyDashboardTotp;
    const clock = dependencies.now ?? (() => new Date());
    const now = (): Date => {
        const value = clock();
        if (!Number.isSafeInteger(value.getTime()) || value.getTime() < 0) {
            throw new RangeError("MFA account clock is invalid");
        }
        return value;
    };
    const sessionIdleDurationMs =
        dependencies.sessionIdleDurationMs ?? browserSessionIdleDurationDefaultMs;
    if (
        !Number.isSafeInteger(sessionIdleDurationMs) ||
        sessionIdleDurationMs < browserSessionIdleDurationMinimumMs ||
        sessionIdleDurationMs > browserSessionIdleDurationMaximumMs
    ) {
        throw new RangeError("MFA session idle duration is invalid");
    }
    const recentAuthenticationWindowMs =
        dependencies.recentAuthenticationWindowMs ?? recentAuthenticationWindowDefaultMs;
    if (
        !Number.isSafeInteger(recentAuthenticationWindowMs) ||
        recentAuthenticationWindowMs < recentAuthenticationWindowMinimumMs ||
        recentAuthenticationWindowMs > recentAuthenticationWindowMaximumMs
    ) {
        throw new RangeError("Recent-auth window is invalid");
    }

    const audit = (
        unit: MfaLifecycleUnitOfWork,
        input: Omit<SecurityAuditEventInput, "id">
    ): void => {
        unit.insertAuditEvent(createSecurityAuditEvent({ ...input, id: generateId() }));
    };
    const readActiveAccount = (
        identity: AuthenticatedBrowserIdentity,
        checkedAt: Date
    ): AccountSnapshot | undefined =>
        dependencies.repository.withReadTransaction((reader) =>
            activeAccount(reader, identity, checkedAt, sessionIdleDurationMs)
        );
    const cryptoHelpers = createAccountLifecycleCryptoHelpers({
        generateId,
        generateRecoveryCodes,
        hashRecoveryCode,
        passwordWorkBudget: dependencies.passwordWorkBudget,
        passwordWorkGate: dependencies.passwordWorkGate,
        totpSecretCipher: dependencies.totpSecretCipher,
        totpWorkBudget: dependencies.totpWorkBudget,
        totpWorkGate: dependencies.totpWorkGate,
        verifyTotp,
    });

    return Object.freeze({
        audit,
        generateId,
        generateSessionToken,
        generateTotpSecret,
        now,
        ...cryptoHelpers,
        passwordWorkBudget: dependencies.passwordWorkBudget,
        passwordWorkGate: dependencies.passwordWorkGate,
        readActiveAccount,
        recentAuthenticationWindowMs,
        repository: dependencies.repository,
        rotateSession,
        sessionIdleDurationMs,
        totpSecretCipher: dependencies.totpSecretCipher,
        totpWorkBudget: dependencies.totpWorkBudget,
        totpWorkGate: dependencies.totpWorkGate,
        verifyPassword,
        verifyRecoveryCode,
        verifyTotp,
    });
}
