import { toJsonSchema } from "@valibot/to-json-schema";

import {
    factorLabelMaximumLength,
    hasValidPossessionFactorInventory,
    isValidFactorLabel,
} from "../../src/contracts/accountSecurity.ts";
import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import type { ContractSchema } from "../../src/contracts/registry.ts";
import {
    hasMatchingWebAuthnAuthenticationCredentialIds,
    hasMatchingWebAuthnRegistrationCredentialIds,
    isCanonicalWebAuthnBase64Url,
    sortWebAuthnTransports,
} from "../../src/contracts/webauthn.ts";
import { hasUniqueArrayItems } from "../../src/shared/validation.ts";

/** JSON Schema conversion direction for transport schemas. */
export type SchemaTypeMode = "input" | "output";

// JSON Schema cannot carry JavaScript's Unicode flag. Encode astral Cf code
// points as surrogate pairs so this remains equivalent to the Valibot \p{Cc}/\p{Cf}
// predicate under the documented ECMA-262 pattern dialect.
const factorLabelControlOrFormatPattern = [
    String.raw`[\u0000-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]`,
    String.raw`\uD804[\uDCBD\uDCCD]`,
    String.raw`\uD80D[\uDC30-\uDC3F]`,
    String.raw`\uD82F[\uDCA0-\uDCA3]`,
    String.raw`\uD834[\uDD73-\uDD7A]`,
    String.raw`\uDB40(?:\uDC01|[\uDC20-\uDC7F])`,
].join("|");
const factorLabelJsonSchemaPattern = `^(?=[\\s\\S]*\\S)(?![\\s\\S]*(?:${factorLabelControlOrFormatPattern}))[\\s\\S]+$`;

function readActionRequirement(action: unknown): unknown {
    return typeof action === "object" && action !== null && "requirement" in action
        ? (action as Record<string, unknown>).requirement
        : undefined;
}

function readActionOperation(action: unknown): unknown {
    return typeof action === "object" && action !== null && "operation" in action
        ? (action as Record<string, unknown>).operation
        : undefined;
}

/**
 * Converts a Valibot transport contract into deterministic JSON Schema.
 * @param schema Valibot source schema.
 * @param schemaId Stable contract schema ID.
 * @param typeMode Whether input or output types are documented.
 * @returns JSON Schema draft 2020-12 document.
 */
export function convertContractSchema(
    schema: ContractSchema,
    schemaId: string,
    typeMode: SchemaTypeMode
): Record<string, unknown> {
    return {
        $id: `urn:mira-dashboard:${schemaId}`,
        ...toJsonSchema(schema, {
            errorMode: "throw",
            overrideAction({ jsonSchema, valibotAction }) {
                const requirement = readActionRequirement(valibotAction);
                const operation = readActionOperation(valibotAction);
                // JSON Schema carries a pattern but no flags. The transport uses
                // Unicode mode only for ASCII-bounded expressions, for which
                // dropping the flag does not change accepted values.
                if (
                    valibotAction.type === "regex" &&
                    requirement instanceof RegExp &&
                    requirement.flags === "u"
                ) {
                    return {
                        ...jsonSchema,
                        pattern: requirement.source,
                    };
                }
                // This exact named refinement is equivalent to draft-2020-12's
                // uniqueItems keyword. Every other unsupported check still fails.
                if (
                    valibotAction.type === "check" &&
                    requirement === hasValidAuthPasswordLength
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: authPasswordMaximumLength,
                        minLength: authPasswordMinimumLength,
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === isValidBrowserSessionUserAgent
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: browserSessionUserAgentMaximumLength,
                        minLength: 1,
                        pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]*$",
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === isValidFactorLabel
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: factorLabelMaximumLength,
                        minLength: 1,
                        pattern: factorLabelJsonSchemaPattern,
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === hasUniqueArrayItems
                ) {
                    return { ...jsonSchema, uniqueItems: true };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === isCanonicalWebAuthnBase64Url
                ) {
                    return {
                        ...jsonSchema,
                        pattern:
                            "^(?:[A-Za-z0-9_-]{4})*(?:[A-Za-z0-9_-][AQgw]|[A-Za-z0-9_-]{2}[AEIMQUYcgkosw048])?$",
                    };
                }
                // Draft 2020-12 has no portable sibling-field equality keyword.
                // The generated schema retains the strict structural bounds while
                // Valibot enforces id === rawId at the live trust boundary.
                if (
                    valibotAction.type === "check" &&
                    (requirement === hasMatchingWebAuthnRegistrationCredentialIds ||
                        requirement === hasMatchingWebAuthnAuthenticationCredentialIds)
                ) {
                    return {
                        ...jsonSchema,
                        $comment:
                            "Live Valibot validation additionally requires id and rawId to match exactly.",
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === hasValidPossessionFactorInventory
                ) {
                    return {
                        ...jsonSchema,
                        $comment:
                            "Live Valibot validation additionally limits the combined TOTP and WebAuthn possession-factor inventory to four.",
                    };
                }
                // JSON Schema validates the same unique bounded set. Canonical
                // ordering is a runtime output normalization, not an input rule.
                if (
                    valibotAction.type === "transform" &&
                    operation === sortWebAuthnTransports
                ) {
                    return jsonSchema;
                }
                return null;
            },
            target: "draft-2020-12",
            typeMode,
        }),
    };
}
