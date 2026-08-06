import * as v from "valibot";

import {
    browserSessionUserAgentMaximumLength,
    isValidBrowserSessionUserAgent,
} from "../../../contracts/auth.ts";
import {
    boundedNonBlankTextSchema,
    lowercaseSha256Action,
} from "../../../shared/validation.ts";
import { isDashboardPasswordHash } from "../../shared/passwordHash.ts";

/** Bun Argon2id hash accepted by the security persistence boundary. */
export const argon2idPasswordHashSchema = v.pipe(
    v.string("Password hash is invalid"),
    v.check(isDashboardPasswordHash, "Password hash is invalid")
);

/** Bounded human-readable label without NUL characters. */
export const securityLabelSchema = boundedNonBlankTextSchema(
    128,
    "Security label is invalid"
);

/** Human-readable security label without Unicode control or format characters. */
export const controlSafeSecurityLabelSchema = v.pipe(
    securityLabelSchema,
    v.check((value) => !/[\p{Cc}\p{Cf}]/u.test(value), "Security label is invalid")
);

/** Bounded user-agent metadata without NUL characters. */
export const securityUserAgentSchema = v.pipe(
    v.string("Session user agent is invalid"),
    v.minLength(1, "Session user agent is invalid"),
    // Valibot counts UTF-16 code units; the domain predicate counts code points.
    // Two units per point keeps the full astral-character allowance reachable.
    v.maxLength(
        browserSessionUserAgentMaximumLength * 2,
        "Session user agent is invalid"
    ),
    v.check(isValidBrowserSessionUserAgent, "Session user agent is invalid")
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
