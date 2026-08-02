import {
    createWebAuthnAuthenticationOptions,
    createWebAuthnRegistrationOptions,
    verifyWebAuthnAuthentication,
    verifyWebAuthnRegistration,
} from "../../services/webAuthn/service.ts";

export interface AccountSecurityWebAuthnDependencies {
    createAuthenticationOptions: typeof createWebAuthnAuthenticationOptions;
    createRegistrationOptions: typeof createWebAuthnRegistrationOptions;
    verifyAuthentication: typeof verifyWebAuthnAuthentication;
    verifyRegistration: typeof verifyWebAuthnRegistration;
}

export const defaultAccountSecurityWebAuthnDependencies: AccountSecurityWebAuthnDependencies =
    {
        createAuthenticationOptions: createWebAuthnAuthenticationOptions,
        createRegistrationOptions: createWebAuthnRegistrationOptions,
        verifyAuthentication: verifyWebAuthnAuthentication,
        verifyRegistration: verifyWebAuthnRegistration,
    };
