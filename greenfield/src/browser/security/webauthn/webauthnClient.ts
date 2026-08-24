import * as v from "valibot";

import {
    type WebAuthnAuthenticationOptions,
    type WebAuthnAuthenticationResponse,
    webAuthnAuthenticationResponseSchema,
    type WebAuthnRegistrationOptions,
    type WebAuthnRegistrationResponse,
    webAuthnRegistrationResponseSchema,
} from "../../../contracts/webauthn.ts";

/** Browser ceremony boundary kept injectable for deterministic security-flow tests. */
export interface DashboardWebAuthnClient {
    authenticate(
        options: WebAuthnAuthenticationOptions
    ): Promise<WebAuthnAuthenticationResponse>;
    register(options: WebAuthnRegistrationOptions): Promise<WebAuthnRegistrationResponse>;
}

/** Low-level browser ceremony port used by the validated Dashboard adapter. */
export interface DashboardWebAuthnCeremonyPort {
    beginAuthentication(options: WebAuthnAuthenticationOptions): Promise<unknown>;
    beginRegistration(options: WebAuthnRegistrationOptions): Promise<unknown>;
}

const simpleWebAuthnCeremonyPort: DashboardWebAuthnCeremonyPort = Object.freeze({
    async beginAuthentication(options: WebAuthnAuthenticationOptions) {
        const { startAuthentication } = await import("@simplewebauthn/browser");
        return startAuthentication({ optionsJSON: options });
    },
    async beginRegistration(options: WebAuthnRegistrationOptions) {
        const { startRegistration } = await import("@simplewebauthn/browser");
        return startRegistration({ optionsJSON: options });
    },
});

/**
 * Creates the browser-owned WebAuthn adapter.
 * Ceremony responses remain ephemeral and are returned only to the requesting mutation.
 * @param ceremonies Low-level WebAuthn browser operations.
 * @returns WebAuthn authentication and registration operations.
 */
export function createDashboardWebAuthnClient(
    ceremonies: DashboardWebAuthnCeremonyPort = simpleWebAuthnCeremonyPort
): DashboardWebAuthnClient {
    return Object.freeze({
        async authenticate(options: WebAuthnAuthenticationOptions) {
            const response = await ceremonies.beginAuthentication(options);
            return v.parse(webAuthnAuthenticationResponseSchema, response);
        },
        async register(options: WebAuthnRegistrationOptions) {
            const response = await ceremonies.beginRegistration(options);
            return v.parse(webAuthnRegistrationResponseSchema, response);
        },
    });
}
