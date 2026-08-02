import {
    createWebAuthnAuthenticationOptions,
    verifyWebAuthnAuthentication,
} from "../../services/webAuthn/service.ts";

export interface AuthWebAuthnDependencies {
    createAuthenticationOptions: typeof createWebAuthnAuthenticationOptions;
    verifyAuthentication: typeof verifyWebAuthnAuthentication;
}

export const defaultAuthWebAuthnDependencies: AuthWebAuthnDependencies = {
    createAuthenticationOptions: createWebAuthnAuthenticationOptions,
    verifyAuthentication: verifyWebAuthnAuthentication,
};
