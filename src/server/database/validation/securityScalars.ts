import * as v from "valibot";

import {
    boundedNonBlankTextSchema,
    lowercaseSha256Action,
} from "../../../shared/validation.ts";

/** Bun Argon2id hash accepted by the security persistence boundary. */
export const argon2idPasswordHashSchema = v.pipe(
    v.string("Password hash is invalid"),
    v.minLength(32, "Password hash is invalid"),
    v.maxLength(512, "Password hash is invalid"),
    v.startsWith("$argon2id$", "Password hash is invalid")
);

/** Bounded human-readable label without NUL characters. */
export const securityLabelSchema = boundedNonBlankTextSchema(
    128,
    "Security label is invalid"
);

/** Bounded user-agent metadata without NUL characters. */
export const securityUserAgentSchema = boundedNonBlankTextSchema(
    512,
    "Session user agent is invalid"
);

/**
 * Refines a generated text column to a lowercase SHA-256 digest.
 * @param schema Generated text-column string schema to refine.
 * @returns Schema requiring the canonical lowercase SHA-256 representation.
 */
export function sha256TextSchema(schema: v.StringSchema<undefined>) {
    return v.pipe(schema, lowercaseSha256Action());
}

export {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
    securityUsernameSchema,
    opaqueSelectorSchema,
} from "../../../contracts/security.ts";
