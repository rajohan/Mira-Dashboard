import { toJsonSchema } from "@valibot/to-json-schema";

import type { ContractSchema } from "../../src/contracts/registry.ts";

/** JSON Schema conversion direction for transport schemas. */
export type SchemaTypeMode = "input" | "output";

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
            target: "draft-2020-12",
            typeMode,
        }),
    };
}
