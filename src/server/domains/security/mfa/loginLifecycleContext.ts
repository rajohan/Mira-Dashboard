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
    globalRateLimitBlockDurations,
    sourceRateLimitBlockDurations,
    type AuthenticationRateLimitTarget,
} from "../authenticationRateLimit.ts";
import type { AuthenticationWorkBudget } from "../authenticationWorkBudget.ts";
import type { AuthenticationWorkGate } from "../authenticationWorkGate.ts";
import { verifyDashboardPassword } from "../password.ts";
import type {
    MfaLifecycleRepository,
    MfaLifecycleUnitOfWork,
} from "./lifecycleRepositoryTypes.ts";
import type { MfaLoginLifecycleDependencies } from "./loginLifecycleTypes.ts";
import type { TotpSecretCipher } from "./totpSecretCipher.ts";

export interface MfaLoginLifecycleContext {
    readonly audit: (
        unit: MfaLifecycleUnitOfWork,
        input: Omit<SecurityAuditEventInput, "id">
    ) => void;
    readonly generatePendingLoginToken: () => GeneratedOpaqueToken;
    readonly generateSessionToken: () => GeneratedOpaqueToken;
    readonly now: () => Date;
    readonly passwordWorkBudget: AuthenticationWorkBudget;
    readonly passwordWorkGate: AuthenticationWorkGate;
    readonly repository: MfaLifecycleRepository;
    readonly sessionIdleDurationMs: number;
    readonly totpSecretCipher: TotpSecretCipher;
    readonly totpWorkBudget: AuthenticationWorkBudget;
    readonly totpWorkGate: AuthenticationWorkGate;
    readonly verifyRecoveryCode: (
        hashInput: string,
        validatorHash: string
    ) => Promise<boolean>;
}

export function mfaLoginRateLimitTargets(
    clientSourceId: string
): readonly AuthenticationRateLimitTarget[] {
    return [
        {
            blockDurations: sourceRateLimitBlockDurations,
            kind: "login-mfa-source",
            sourceScoped: true,
            subject: clientSourceId,
        },
        {
            blockDurations: globalRateLimitBlockDurations,
            kind: "login-mfa-global",
            subject: "all-sources",
        },
    ];
}

/**
 * Builds validated policy and cryptographic dependencies for MFA login operations.
 * @returns Frozen context consumed through narrow operation ports.
 */
export function createMfaLoginLifecycleContext(
    dependencies: MfaLoginLifecycleDependencies
): MfaLoginLifecycleContext {
    const generateId = dependencies.generateId ?? (() => Bun.randomUUIDv7());
    const generatePendingLoginToken =
        dependencies.generatePendingLoginToken ??
        (() => generateOpaqueToken("pending-login"));
    const generateSessionToken =
        dependencies.generateSessionToken ?? (() => generateOpaqueToken("session"));
    const verifyRecoveryCode = dependencies.verifyRecoveryCode ?? verifyDashboardPassword;
    const clock = dependencies.now ?? (() => new Date());
    const now = (): Date => {
        const value = clock();
        if (!Number.isSafeInteger(value.getTime()) || value.getTime() < 0) {
            throw new RangeError("MFA login clock is invalid");
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
    const audit: MfaLoginLifecycleContext["audit"] = (unit, input) => {
        unit.insertAuditEvent(createSecurityAuditEvent({ ...input, id: generateId() }));
    };

    return Object.freeze({
        audit,
        generatePendingLoginToken,
        generateSessionToken,
        now,
        passwordWorkBudget: dependencies.passwordWorkBudget,
        passwordWorkGate: dependencies.passwordWorkGate,
        repository: dependencies.repository,
        sessionIdleDurationMs,
        totpSecretCipher: dependencies.totpSecretCipher,
        totpWorkBudget: dependencies.totpWorkBudget,
        totpWorkGate: dependencies.totpWorkGate,
        verifyRecoveryCode,
    });
}
