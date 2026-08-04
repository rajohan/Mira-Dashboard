import {
    procedureContracts,
    rawHttpContracts,
    realtimeEventContracts,
} from "../../src/contracts/contractRegistry.ts";
import type { ContractSchema } from "../../src/contracts/registry.ts";
import { bunRuntimePolicy } from "../../src/shared/bunRuntimePolicy.ts";
import { convertContractSchema, type SchemaTypeMode } from "./jsonSchema.ts";
import {
    type PackageDocumentationInput,
    renderGeneratedIndex,
    renderPackagesAndRuntime,
    renderProcedures,
    renderRawHttp,
    renderRealtimeEvents,
} from "./markdown.ts";

interface RegisteredSchema {
    schema: ContractSchema;
    typeMode: SchemaTypeMode;
}

/** Package fields consumed by generated documentation. */
export interface DocumentationPackageManifest {
    dependencies: Readonly<Record<string, string>>;
    devDependencies: Readonly<Record<string, string>>;
    resolvedVersions: Readonly<Record<string, string>>;
}

function registerSchema(
    schemas: Map<string, RegisteredSchema>,
    schemaId: string,
    schema: ContractSchema,
    typeMode: SchemaTypeMode
): void {
    const existing = schemas.get(schemaId);
    if (existing && (existing.schema !== schema || existing.typeMode !== typeMode)) {
        throw new Error(`Contract schema ID is registered inconsistently: ${schemaId}`);
    }
    schemas.set(schemaId, { schema, typeMode });
}

function collectSchemas(): Map<string, RegisteredSchema> {
    const schemas = new Map<string, RegisteredSchema>();
    for (const contract of procedureContracts) {
        registerSchema(schemas, contract.inputSchemaId, contract.input, "input");
        registerSchema(schemas, contract.outputSchemaId, contract.output, "output");
    }
    for (const contract of rawHttpContracts) {
        registerSchema(schemas, contract.responseSchemaId, contract.response, "output");
    }
    for (const contract of realtimeEventContracts) {
        registerSchema(schemas, contract.payloadSchemaId, contract.payload, "output");
    }
    return schemas;
}

function schemaArtifactPath(schemaId: string): string {
    if (!/^[A-Za-z0-9.-]+$/u.test(schemaId)) {
        throw new Error(
            `Contract schema ID is not safe for an artifact path: ${schemaId}`
        );
    }
    return `schemas/${schemaId}.schema.json`;
}

/**
 * Builds every generated documentation artifact in memory.
 * @param packageManifest Declared package constraints and exact lockfile resolutions.
 * @returns Sorted artifact path/content pairs.
 */
export function buildDocumentationArtifacts(
    packageManifest: DocumentationPackageManifest
): ReadonlyMap<string, string> {
    const packageInput: PackageDocumentationInput = {
        dependencies: packageManifest.dependencies,
        developmentDependencies: packageManifest.devDependencies,
        resolvedVersions: packageManifest.resolvedVersions,
        runtime: bunRuntimePolicy,
    };
    const artifacts = new Map<string, string>([
        ["README.md", renderGeneratedIndex()],
        ["packages-and-runtime.md", renderPackagesAndRuntime(packageInput)],
        ["procedures.md", renderProcedures(procedureContracts)],
        ["raw-http.md", renderRawHttp(rawHttpContracts)],
        ["realtime-events.md", renderRealtimeEvents(realtimeEventContracts)],
    ]);

    for (const [schemaId, registered] of collectSchemas()) {
        const jsonSchema = convertContractSchema(
            registered.schema,
            schemaId,
            registered.typeMode
        );
        artifacts.set(
            schemaArtifactPath(schemaId),
            `${JSON.stringify(jsonSchema, null, 2)}\n`
        );
    }

    return new Map(
        [...artifacts].toSorted(([left], [right]) => left.localeCompare(right))
    );
}
