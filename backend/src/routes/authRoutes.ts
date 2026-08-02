import { createAuthBootstrapRoutes } from "./auth/bootstrapRoutes.ts";
import { createMfaLoginRoutes } from "./auth/mfaLoginRoutes.ts";
import { createPasswordLoginRoutes } from "./auth/passwordLoginRoutes.ts";
import { createAuthSessionRoutes } from "./auth/sessionRoutes.ts";
import {
    defaultAuthWebAuthnDependencies,
    type AuthWebAuthnDependencies,
} from "./auth/webAuthnDependencies.ts";

/**
 * Composes bootstrap, password, MFA, and session authentication routes.
 * @param webAuthn WebAuthn operations, replaceable for characterization tests.
 * @returns Authentication route table.
 */
export function createAuthRoutes(
    webAuthn: AuthWebAuthnDependencies = defaultAuthWebAuthnDependencies
) {
    return {
        ...createAuthBootstrapRoutes(),
        ...createAuthSessionRoutes(),
        ...createPasswordLoginRoutes(),
        ...createMfaLoginRoutes(webAuthn),
    } as const;
}

export const authRoutes = createAuthRoutes();
