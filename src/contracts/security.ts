import * as v from "valibot";

import {
    boundedNonBlankStringSchema,
    hasUniqueArrayItems,
} from "../shared/validation.ts";

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

export const authenticatedPrincipalSchema = v.pipe(
    v.strictObject({
        capabilities: principalCapabilitiesSchema,
        id: boundedNonBlankStringSchema(128, "Principal id is invalid"),
        kind: v.picklist(["automation", "session"]),
    }),
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
