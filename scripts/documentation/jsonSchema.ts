import { toJsonSchema } from "@valibot/to-json-schema";

import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import type { ContractSchema } from "../../src/contracts/registry.ts";
import { hasUniqueArrayItems } from "../../src/shared/validation.ts";

/** JSON Schema conversion direction for transport schemas. */
export type SchemaTypeMode = "input" | "output";

function readActionRequirement(action: unknown): unknown {
    return typeof action === "object" && action !== null && "requirement" in action
        ? (action as Record<string, unknown>).requirement
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
                    requirement === hasUniqueArrayItems
                ) {
                    return { ...jsonSchema, uniqueItems: true };
                }
                return null;
            },
            target: "draft-2020-12",
            typeMode,
        }),
    };
}
