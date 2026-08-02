import { createMfaAdministrationRoutes } from "./accountSecurity/mfaAdministrationRoutes.ts";
import { createAccountPasswordRoutes } from "./accountSecurity/passwordRoutes.ts";
import { createAccountSessionRoutes } from "./accountSecurity/sessionRoutes.ts";
import { createAccountSecurityStepUpRoutes } from "./accountSecurity/stepUpRoutes.ts";
import { createAccountTotpRoutes } from "./accountSecurity/totpRoutes.ts";
import {
    defaultAccountSecurityWebAuthnDependencies,
    type AccountSecurityWebAuthnDependencies,
} from "./accountSecurity/webAuthnDependencies.ts";
import { createAccountWebAuthnRoutes } from "./accountSecurity/webAuthnRoutes.ts";

/**
 * Composes account-security routes from the password, step-up, factor, and session domains.
 * @param webAuthn WebAuthn operations, replaceable for characterization tests.
 * @returns Account-security route table.
 */
export function createAccountSecurityRoutes(
    webAuthn: AccountSecurityWebAuthnDependencies = defaultAccountSecurityWebAuthnDependencies
) {
    return {
        ...createAccountPasswordRoutes(),
        ...createAccountSecurityStepUpRoutes(webAuthn),
        ...createAccountTotpRoutes(),
        ...createAccountWebAuthnRoutes(webAuthn),
        ...createMfaAdministrationRoutes(),
        ...createAccountSessionRoutes(),
    } as const;
}

export const accountSecurityRoutes = createAccountSecurityRoutes();
