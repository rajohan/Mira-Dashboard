import * as v from "valibot";

import {
    boundedControlSafeTextSchema,
    compareStrings,
    hasUniqueArrayItems,
    lowercaseUuidV7Schema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";

/** Second-factor methods implemented by this authentication slice. */
export const multiFactorAuthenticationMethods = ["recovery", "totp", "webauthn"] as const;

export type MultiFactorAuthenticationMethod =
    (typeof multiFactorAuthenticationMethods)[number];

export const multiFactorAuthenticationMethodSchema = v.picklist(
    multiFactorAuthenticationMethods,
    "Multi-factor authentication method is invalid"
);

/** Authentication methods implemented by durable browser sessions. */
export const authenticationMethods = [
    "password",
    ...multiFactorAuthenticationMethods,
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

/** Shared Unicode code-point budget for operator-managed security labels. */
export const securityLabelMaximumLength = 128;

/**
 * Validates a bounded, nonblank label without Unicode control or format characters.
 * @param value Candidate operator-managed label.
 * @returns Whether the label satisfies the shared security policy.
 */
export function isValidSecurityLabel(value: string): boolean {
    return v.safeParse(boundedControlSafeTextSchema(securityLabelMaximumLength), value)
        .success;
}

/** Control-safe label shared by account factors and automation identities. */
export const securityLabelSchema = v.pipe(
    v.string("Security label is invalid"),
    v.minLength(1, "Security label is invalid"),
    // Valibot counts UTF-16 code units. Two units per code point preserves the
    // full astral-character budget before the domain predicate runs.
    v.maxLength(securityLabelMaximumLength * 2, "Security label is invalid"),
    v.check(isValidSecurityLabel, "Security label is invalid")
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

/** Complete canonical opaque token returned once when a credential is created. */
export const opaqueTokenSchema = v.pipe(
    v.string("Opaque token is invalid"),
    v.length(97, "Opaque token is invalid"),
    v.regex(/^[0-9a-f]{32}\.[0-9a-f]{64}$/u, "Opaque token is invalid")
);

/** Canonical UUIDv7 identity for users and managed security records. */
export const securityRecordIdSchema = lowercaseUuidV7Schema(
    "Security record id is invalid"
);

/** Capabilities referenced by currently implemented authenticated contracts. */
export const applicationCapabilities = [
    "agents:read",
    "agents:write",
    "cache:read",
    "cache:write",
    "jobs:read",
    "jobs:write",
    "monitoring:write",
    "notifications:read",
    "notifications:write",
    "reports:read",
    "reports:write",
    "tasks:read",
    "tasks:write",
] as const;

/** One capability granted to an authenticated application principal. */
export type ApplicationCapability = (typeof applicationCapabilities)[number];

export const applicationCapabilitySchema = v.picklist(
    applicationCapabilities,
    "Application capability is invalid"
);

/**
 * Canonicalizes validated capabilities for stable authorization and contract output.
 * @param capabilities Validated unique application capabilities.
 * @returns A frozen list in canonical capability order.
 */
export function sortApplicationCapabilities(
    capabilities: ApplicationCapability[]
): readonly ApplicationCapability[] {
    const sorted = capabilities.toSorted(compareStrings);
    Object.freeze(sorted);
    return sorted;
}

export const applicationCapabilityListSchema = v.pipe(
    v.array(applicationCapabilitySchema, "Principal capabilities are invalid"),
    v.maxLength(
        applicationCapabilities.length,
        "Principal capability count is outside its budget"
    ),
    v.check(
        hasUniqueArrayItems<ApplicationCapability>,
        "Principal capabilities must be unique"
    ),
    v.transform(sortApplicationCapabilities)
);

const authenticatedPrincipalBaseEntries = {
    authorizationVersion: positiveSafeIntegerSchema(
        "Principal authorization version is invalid"
    ),
    capabilities: applicationCapabilityListSchema,
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
