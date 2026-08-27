import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
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

interface SimpleWebAuthnCeremonies {
    readonly startAuthentication: (input: {
        readonly optionsJSON: WebAuthnAuthenticationOptions;
    }) => Promise<unknown>;
    readonly startRegistration: (input: {
        readonly optionsJSON: WebAuthnRegistrationOptions;
    }) => Promise<unknown>;
}

/**
 * Creates the eagerly loaded SimpleWebAuthn ceremony adapter.
 * @returns Browser ceremony port without a click-time module import.
 */
export function createSimpleWebAuthnCeremonyPort(
    ceremonies?: SimpleWebAuthnCeremonies
): DashboardWebAuthnCeremonyPort {
    const selected = ceremonies ?? { startAuthentication, startRegistration };
    return Object.freeze({
        beginAuthentication: (options: WebAuthnAuthenticationOptions) =>
            selected.startAuthentication({ optionsJSON: options }),
        beginRegistration: (options: WebAuthnRegistrationOptions) =>
            selected.startRegistration({ optionsJSON: options }),
    });
}

const simpleWebAuthnCeremonyPort = createSimpleWebAuthnCeremonyPort();

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
