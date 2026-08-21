import databaseSnapshot from "../../migrations/20260804022252_dashboard-foundation/snapshot.json";
import {
    procedureContracts,
    rawHttpContracts,
    realtimeEventContracts,
} from "../../src/contracts/contractRegistry.ts";
import type {
    ContractSchema,
    RawHttpBodyContract,
} from "../../src/contracts/registry.ts";
import { dashboardRouteDocumentation } from "../../src/shared/browserRouteRegistry.ts";
import { bunRuntimePolicy } from "../../src/shared/bunRuntimePolicy.ts";
import { applicationConfigurationRegistry } from "../../src/shared/configuration/applicationConfigurationRegistry.ts";
import { convertContractSchema, type SchemaTypeMode } from "./jsonSchema.ts";
import {
    type PackageDocumentationInput,
    renderBrowserRoutes,
    renderConfiguration,
    renderDatabase,
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
        if (contract.requestBody.kind === "schema") {
            registerSchema(
                schemas,
                contract.requestBody.schemaId,
                contract.requestBody.schema,
                "input"
            );
        }
        if (contract.response.kind === "schema") {
            registerSchema(
                schemas,
                contract.response.schemaId,
                contract.response.schema,
                "output"
            );
        }
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

function openApiContent(body: RawHttpBodyContract): Record<string, unknown> | undefined {
    if (body.kind === "none" || body.kind === "websocket") return undefined;
    if (body.kind === "schema") {
        return Object.fromEntries(
            body.contentTypes.map((contentType) => [
                contentType,
                { schema: { $ref: `#/components/schemas/${body.schemaId}` } },
            ])
        );
    }
    return Object.fromEntries(
        body.contentTypes.map((contentType) => [
            contentType,
            {
                schema: {
                    format: "binary",
                    maxLength: body.maximumBytes,
                    type: "string",
                },
            },
        ])
    );
}

function renderRawHttpOpenApi(schemas: ReadonlyMap<string, RegisteredSchema>): string {
    const components = Object.fromEntries(
        [...schemas].map(([schemaId, registered]) => [
            schemaId,
            convertContractSchema(registered.schema, schemaId, registered.typeMode),
        ])
    );
    const paths: Record<string, Record<string, unknown>> = {};
    for (const contract of rawHttpContracts) {
        const openApiPath = contract.path.replaceAll(/:([A-Za-z0-9_]+)/gu, "{$1}");
        const responseContent = openApiContent(contract.response);
        const operation: Record<string, unknown> = {
            responses: Object.fromEntries(
                contract.statusCodes.map((status) => [
                    String(status),
                    {
                        description:
                            status >= 400
                                ? "Expected error response"
                                : "Successful response",
                        ...(status < 400 && responseContent !== undefined
                            ? { content: responseContent }
                            : {}),
                    },
                ])
            ),
            summary: contract.summary,
        };
        const pathParameters = [...contract.path.matchAll(/:([A-Za-z0-9_]+)/gu)].map(
            ([, name]) => ({
                in: "path",
                name,
                required: true,
                schema: { type: "string" },
            })
        );
        const queryParameters =
            contract.query?.parameters.map((parameter) => ({
                in: "query",
                name: parameter.name,
                required: parameter.required,
                schema: { enum: parameter.values, type: "string" },
            })) ?? [];
        if (pathParameters.length > 0 || queryParameters.length > 0) {
            operation.parameters = [...pathParameters, ...queryParameters];
        }
        const requestContent = openApiContent(contract.requestBody);
        if (requestContent !== undefined) {
            operation.requestBody = {
                content: requestContent,
                required: true,
            };
        }
        const pathOperations = paths[openApiPath] ?? {};
        pathOperations[contract.method.toLowerCase()] = operation;
        paths[openApiPath] = pathOperations;
    }
    return `${JSON.stringify(
        {
            components: { schemas: components },
            info: { title: "Mira Dashboard raw HTTP API", version: "1.0.0" },
            openapi: "3.1.0",
            paths,
        },
        null,
        2
    )}\n`;
}

function databaseTables() {
    const entries = databaseSnapshot.ddl as readonly Record<string, unknown>[];
    const primaryKeys = new Set(
        entries
            .filter((entry) => entry.entityType === "pks")
            .flatMap((entry) =>
                (entry.columns as readonly string[]).map(
                    (column) => `${String(entry.table)}:${column}`
                )
            )
    );
    return entries
        .filter((entry) => entry.entityType === "tables")
        .map((table) => {
            const tableName = String(table.name);
            return {
                columns: entries
                    .filter(
                        (entry) =>
                            entry.entityType === "columns" && entry.table === tableName
                    )
                    .map((column) => ({
                        defaulted: column.default !== null,
                        name: String(column.name),
                        notNull: column.notNull === true,
                        primaryKey: primaryKeys.has(
                            `${tableName}:${String(column.name)}`
                        ),
                        type: String(column.type),
                    })),
                name: tableName,
            };
        });
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
    const schemas = collectSchemas();
    const artifacts = new Map<string, string>([
        ["README.md", renderGeneratedIndex()],
        ["configuration.md", renderConfiguration(applicationConfigurationRegistry)],
        ["database.md", renderDatabase(databaseTables())],
        ["openapi.raw-http.json", renderRawHttpOpenApi(schemas)],
        ["packages-and-runtime.md", renderPackagesAndRuntime(packageInput)],
        ["procedures.md", renderProcedures(procedureContracts)],
        ["raw-http.md", renderRawHttp(rawHttpContracts)],
        ["realtime-events.md", renderRealtimeEvents(realtimeEventContracts)],
        ["routes-and-features.md", renderBrowserRoutes(dashboardRouteDocumentation)],
    ]);

    for (const [schemaId, registered] of schemas) {
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

    const browserDocuments = [...artifacts]
        .filter(([artifactPath]) => artifactPath !== "browser-reference.json")
        .map(([artifactPath, content]) =>
            artifactPath.startsWith("schemas/")
                ? { kind: "schema", path: artifactPath }
                : {
                      content,
                      kind: artifactPath.endsWith(".json") ? "json" : "markdown",
                      path: artifactPath,
                  }
        );
    artifacts.set("browser-reference.json", `${JSON.stringify(browserDocuments)}\n`);

    return new Map(
        [...artifacts].toSorted(([left], [right]) => left.localeCompare(right))
    );
}
