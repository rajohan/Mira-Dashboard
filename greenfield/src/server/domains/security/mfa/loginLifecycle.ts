import { createMfaLoginCoordinator } from "./loginCoordinator.ts";
import { createMfaLoginLifecycleContext } from "./loginLifecycleContext.ts";
import type {
    MfaLoginLifecycleDependencies,
    MfaLoginLifecycleService,
} from "./loginLifecycleTypes.ts";
import { createPendingLoginOperations } from "./loginPendingLifecycle.ts";
import { createRecoveryLoginOperation } from "./loginRecoveryProof.ts";
import { createTotpLoginOperation } from "./loginTotpProof.ts";
import { createWebAuthnLoginChallengeOperation } from "./loginWebAuthnChallenge.ts";
import { createWebAuthnLoginProofOperation } from "./loginWebAuthnProof.ts";

export type {
    BeginPendingLoginInput,
    BeginPendingLoginResult,
    BeginWebAuthnLoginLifecycleResult,
    CompleteMfaLoginResult,
    MfaLoginLifecycleDependencies,
    MfaLoginLifecycleService,
} from "./loginLifecycleTypes.ts";

/**
 * Creates the password-first MFA login service from focused operation pipelines.
 * @returns Frozen compatibility facade over pending, recovery, and TOTP operations.
 */
export function createMfaLoginLifecycleService(
    dependencies: MfaLoginLifecycleDependencies
): MfaLoginLifecycleService {
    const context = createMfaLoginLifecycleContext(dependencies);
    const coordinator = createMfaLoginCoordinator(context);
    return Object.freeze({
        ...createPendingLoginOperations(context),
        ...createRecoveryLoginOperation(context, coordinator),
        ...createTotpLoginOperation(context, coordinator),
        ...createWebAuthnLoginChallengeOperation(context),
        ...createWebAuthnLoginProofOperation(context, coordinator),
    });
}
