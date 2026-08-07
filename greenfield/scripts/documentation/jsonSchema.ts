import { toJsonSchema } from "@valibot/to-json-schema";

import { hasValidPossessionFactorInventory } from "../../src/contracts/accountSecurity.ts";
import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import {
    automationCredentialDoesNotReplaceItself,
    automationCredentialPageCountIsConsistent,
    automationCredentialPageCursorIsConsistent,
    automationCredentialRowsHaveStableOrder,
    automationCredentialTimesAreOrdered,
    automationPrincipalCredentialCountsAreConsistent,
    automationPrincipalPageCountsAreConsistent,
    automationPrincipalPageCursorIsConsistent,
    automationPrincipalRowsHaveStableOrder,
    automationPrincipalTimesAreOrdered,
    createdAutomationCredentialResultIsConsistent,
    createdAutomationPrincipalResultIsConsistent,
    disabledAutomationPrincipalResultIsConsistent,
    revokedAutomationCredentialResultIsConsistent,
    rotatedAutomationCredentialResultIsConsistent,
} from "../../src/contracts/automationSecurity.ts";
import type { ContractSchema } from "../../src/contracts/registry.ts";
import {
    isValidSecurityLabel,
    securityLabelMaximumLength,
    sortApplicationCapabilities,
} from "../../src/contracts/security.ts";
import {
    securityAuditEventsHaveStableOrder,
    securityAuditPageCursorIsConsistent,
} from "../../src/contracts/securityAudit.ts";
import {
    hasMatchingWebAuthnAuthenticationCredentialIds,
    hasMatchingWebAuthnRegistrationCredentialIds,
    isCanonicalWebAuthnBase64Url,
    sortWebAuthnTransports,
} from "../../src/contracts/webauthn.ts";
import {
    getBoundedNonBlankTextMaximumLength,
    hasNoNulCharacter,
    hasUniqueArrayItems,
} from "../../src/shared/validation.ts";

/** JSON Schema conversion direction for transport schemas. */
export type SchemaTypeMode = "input" | "output";

// JSON Schema cannot carry JavaScript's Unicode flag. Encode astral Cf code
// points as surrogate pairs so this remains equivalent to the Valibot \p{Cc}/\p{Cf}
// predicate under the documented ECMA-262 pattern dialect.
const securityLabelControlOrFormatPattern = [
    String.raw`[\u0000-\u001F\u007F-\u009F\u00AD\u0600-\u0605\u061C\u06DD\u070F\u0890-\u0891\u08E2\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF\uFFF9-\uFFFB]`,
    String.raw`\uD804[\uDCBD\uDCCD]`,
    String.raw`\uD80D[\uDC30-\uDC3F]`,
    String.raw`\uD82F[\uDCA0-\uDCA3]`,
    String.raw`\uD834[\uDD73-\uDD7A]`,
    String.raw`\uDB40(?:\uDC01|[\uDC20-\uDC7F])`,
].join("|");
const securityLabelJsonSchemaPattern = `^(?=[\\s\\S]*\\S)(?![\\s\\S]*(?:${securityLabelControlOrFormatPattern}))[\\s\\S]+$`;
const noNulJsonSchemaPattern = String.raw`^[^\u0000]*$`;

const runtimeCheckComments = new Map<unknown, string>([
    [
        automationCredentialTimesAreOrdered,
        "Live Valibot validation additionally requires credential expiry after creation and revocation no earlier than creation.",
    ],
    [
        automationCredentialDoesNotReplaceItself,
        "Live Valibot validation additionally requires a replacement credential to reference a different credential ID.",
    ],
    [
        automationPrincipalTimesAreOrdered,
        "Live Valibot validation additionally orders principal creation, update, and disable timestamps.",
    ],
    [
        automationPrincipalCredentialCountsAreConsistent,
        "Live Valibot validation additionally bounds active credentials by the total and requires zero active credentials when disabled.",
    ],
    [
        automationPrincipalRowsHaveStableOrder,
        "Live Valibot validation additionally requires strict newest-first ordering by creation timestamp and ID.",
    ],
    [
        automationCredentialRowsHaveStableOrder,
        "Live Valibot validation additionally requires strict newest-first ordering by creation timestamp and ID.",
    ],
    [
        automationPrincipalPageCountsAreConsistent,
        "Live Valibot validation additionally requires principal page and active counts not to exceed the total count.",
    ],
    [
        automationPrincipalPageCursorIsConsistent,
        "Live Valibot validation additionally requires a principal continuation cursor to identify the returned last row.",
    ],
    [
        automationCredentialPageCountIsConsistent,
        "Live Valibot validation additionally requires the credential page count not to exceed the total count.",
    ],
    [
        automationCredentialPageCursorIsConsistent,
        "Live Valibot validation additionally requires a credential continuation cursor to identify the returned last row.",
    ],
    [
        createdAutomationPrincipalResultIsConsistent,
        "Live Valibot validation additionally binds a new principal to one active initial credential and its matching one-time token prefix.",
    ],
    [
        createdAutomationCredentialResultIsConsistent,
        "Live Valibot validation additionally requires a new standalone credential and matching one-time token prefix.",
    ],
    [
        rotatedAutomationCredentialResultIsConsistent,
        "Live Valibot validation additionally requires a staged predecessor link and matching one-time token prefix.",
    ],
    [
        revokedAutomationCredentialResultIsConsistent,
        "Live Valibot validation additionally requires every revoke result to include its durable revocation timestamp.",
    ],
    [
        disabledAutomationPrincipalResultIsConsistent,
        "Live Valibot validation additionally requires terminal disabled state and zero newly revoked credentials for an idempotent no-op.",
    ],
    [
        securityAuditEventsHaveStableOrder,
        "Live Valibot validation additionally requires strict newest-first audit-event ordering by occurrence timestamp and ID.",
    ],
    [
        securityAuditPageCursorIsConsistent,
        "Live Valibot validation additionally requires an audit continuation cursor to identify the returned last event.",
    ],
]);

function appendJsonSchemaComment(
    jsonSchema: object,
    comment: string
): Record<string, unknown> {
    const existing =
        "$comment" in jsonSchema
            ? (jsonSchema as { readonly $comment?: unknown }).$comment
            : undefined;
    return {
        ...jsonSchema,
        $comment:
            typeof existing === "string" && existing.length > 0
                ? `${existing} ${comment}`
                : comment,
    };
}

function appendJsonSchemaPattern(
    jsonSchema: object,
    pattern: string
): Record<string, unknown> {
    const existingPattern =
        "pattern" in jsonSchema && typeof jsonSchema.pattern === "string"
            ? jsonSchema.pattern
            : undefined;
    if (existingPattern === undefined) return { ...jsonSchema, pattern };

    const existingAllOfValue: unknown = Reflect.get(jsonSchema, "allOf");
    const existingAllOf: readonly unknown[] = Array.isArray(existingAllOfValue)
        ? (existingAllOfValue as unknown[])
        : [];
    return {
        ...jsonSchema,
        allOf: [...existingAllOf, { pattern }],
    };
}

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
                    requirement === isValidSecurityLabel
                ) {
                    return {
                        ...jsonSchema,
                        maxLength: securityLabelMaximumLength,
                        minLength: 1,
                        pattern: securityLabelJsonSchemaPattern,
                    };
                }
                if (
                    valibotAction.type === "check" &&
                    requirement === hasUniqueArrayItems
                ) {
                    return { ...jsonSchema, uniqueItems: true };
                }
                if (valibotAction.type === "check" && requirement === hasNoNulCharacter) {
                    return appendJsonSchemaPattern(jsonSchema, noNulJsonSchemaPattern);
                }
                if (valibotAction.type === "check") {
                    const maximumLength =
                        getBoundedNonBlankTextMaximumLength(requirement);
                    if (maximumLength !== undefined) {
                        return {
                            ...jsonSchema,
                            maxLength: maximumLength,
                            minLength: 1,
                        };
                    }
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
                if (valibotAction.type === "check") {
                    const comment = runtimeCheckComments.get(requirement);
                    if (comment !== undefined) {
                        return appendJsonSchemaComment(jsonSchema, comment);
                    }
                }
                // JSON Schema validates the same unique bounded set. Canonical
                // ordering is a runtime output normalization, not an input rule.
                if (
                    valibotAction.type === "transform" &&
                    (operation === sortWebAuthnTransports ||
                        operation === sortApplicationCapabilities)
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
