import * as v from "valibot";

import {
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";

/** Authentication methods represented by durable browser sessions. */
export const authenticationMethods = [
    "password",
    "recovery",
    "totp",
    "webauthn",
] as const;

export type AuthenticationMethod = (typeof authenticationMethods)[number];

export const authenticationMethodSchema = v.picklist(
    authenticationMethods,
    "Authentication method is invalid"
);

/** Canonical sole-operator username used at login and persistence boundaries. */
export const securityUsernameSchema = v.pipe(
    v.string("Username is invalid"),
    v.minLength(3, "Username is invalid"),
    v.maxLength(32, "Username is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Username is invalid")
);

/** Stable identifier for a named automation caller, independent of its credentials. */
export const automationPrincipalIdSchema = v.pipe(
    v.string("Automation principal id is invalid"),
    v.minLength(1, "Automation principal id is invalid"),
    v.maxLength(64, "Automation principal id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Automation principal id is invalid")
);

/** Non-secret 128-bit selector used to identify an opaque token. */
export const opaqueSelectorSchema = v.pipe(
    v.string("Opaque selector is invalid"),
    v.length(32, "Opaque selector is invalid"),
    v.regex(/^[0-9a-f]{32}$/u, "Opaque selector is invalid")
);

/** Canonical UUIDv7 identity for users and managed security records. */
export const securityRecordIdSchema = lowercaseUuidV7Schema(
    "Security record id is invalid"
);

/** Capabilities referenced by currently implemented authenticated contracts. */
export const applicationCapabilities = ["notifications:read", "reports:read"] as const;

/** One capability granted to an authenticated application principal. */
export type ApplicationCapability = (typeof applicationCapabilities)[number];

export const applicationCapabilitySchema = v.picklist(
    applicationCapabilities,
    "Application capability is invalid"
);

const principalCapabilitiesSchema = v.pipe(
    v.array(applicationCapabilitySchema, "Principal capabilities are invalid"),
    v.maxLength(
        applicationCapabilities.length,
        "Principal capability count is outside its budget"
    ),
    v.check(
        hasUniqueArrayItems<ApplicationCapability>,
        "Principal capabilities must be unique"
    ),
    v.transform((capabilities) => Object.freeze(capabilities.toSorted()))
);

const authenticatedPrincipalBaseEntries = {
    authorizationVersion: positiveSafeIntegerSchema(
        "Principal authorization version is invalid"
    ),
    capabilities: principalCapabilitiesSchema,
};

const automationAuthenticatedPrincipalSchema = v.strictObject({
    ...authenticatedPrincipalBaseEntries,
    authenticatorId: securityRecordIdSchema,
    id: automationPrincipalIdSchema,
    kind: v.literal("automation"),
});

const sessionAuthenticatedPrincipalSchema = v.strictObject({
    ...authenticatedPrincipalBaseEntries,
    authenticatorId: opaqueSelectorSchema,
    id: securityRecordIdSchema,
    kind: v.literal("session"),
});

export const authenticatedPrincipalSchema = v.pipe(
    v.variant("kind", [
        automationAuthenticatedPrincipalSchema,
        sessionAuthenticatedPrincipalSchema,
    ]),
    v.transform((principal) => Object.freeze(principal))
);

const anonymousAuthenticationSchema = v.strictObject({
    kind: v.literal("anonymous"),
});
const invalidAuthenticationSchema = v.strictObject({
    kind: v.literal("invalid"),
});
const authenticatedRequestSchema = v.strictObject({
    kind: v.literal("authenticated"),
    principal: authenticatedPrincipalSchema,
});

export const requestAuthenticationSchema = v.pipe(
    v.variant("kind", [
        anonymousAuthenticationSchema,
        invalidAuthenticationSchema,
        authenticatedRequestSchema,
    ]),
    v.transform((authentication) => Object.freeze(authentication))
);

export type AuthenticatedPrincipal = v.InferOutput<typeof authenticatedPrincipalSchema>;
export type RequestAuthentication = v.InferOutput<typeof requestAuthenticationSchema>;
