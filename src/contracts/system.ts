import * as v from "valibot";

import type { ProcedureContract, RawHttpContract } from "./registry.ts";

/** Empty object accepted by procedures without user input. */
export const emptyInputSchema = v.optional(v.strictObject({}), {});

/** Public runtime identity returned by the system procedure. */
export const runtimeIdentitySchema = v.strictObject({
    revision: v.pipe(v.string(), v.description("Full Bun Git revision.")),
    version: v.pipe(v.string(), v.description("Bun semantic version.")),
    versionWithRevision: v.pipe(
        v.string(),
        v.description("Human-readable Bun version and short diagnostic revision.")
    ),
});

/** Liveness response returned while the Bun process can answer requests. */
export const livenessStatusSchema = v.strictObject({
    status: v.literal("live"),
});

/** Readiness response returned before and after critical initialization. */
export const readinessStatusSchema = v.strictObject({
    status: v.picklist(["not-ready", "ready"]),
});

/** Runtime identity contract shared by tRPC wiring and generated documentation. */
export const runtimeIdentityContract = {
    access: { kind: "public" },
    domain: "system",
    errors: [],
    input: emptyInputSchema,
    inputSchemaId: "system.runtimeIdentity.input",
    kind: "query",
    name: "system.runtimeIdentity",
    output: runtimeIdentitySchema,
    outputSchemaId: "system.runtimeIdentity.output",
    summary: "Returns the Bun runtime identity of the serving process.",
} as const satisfies ProcedureContract;

/** Implemented system tRPC contracts. */
export const systemProcedureContracts = [runtimeIdentityContract] as const;

/** Implemented raw health-route contracts. */
export const systemRawHttpContracts = [
    {
        access: { kind: "public" },
        method: "GET",
        path: "/api/health/live",
        response: {
            kind: "schema",
            schema: livenessStatusSchema,
            schemaId: "health.liveness.response",
        },
        statusCodes: [200],
        summary: "Confirms that the Bun web process can answer requests.",
    },
    {
        access: { kind: "public" },
        method: "HEAD",
        path: "/api/health/live",
        response: { kind: "none" },
        statusCodes: [200],
        summary: "Checks Bun web-process liveness without a response body.",
    },
    {
        access: { kind: "public" },
        method: "GET",
        path: "/api/health/ready",
        response: {
            kind: "schema",
            schema: readinessStatusSchema,
            schemaId: "health.readiness.response",
        },
        statusCodes: [200, 503],
        summary: "Reports whether critical application initialization is complete.",
    },
    {
        access: { kind: "public" },
        method: "HEAD",
        path: "/api/health/ready",
        response: { kind: "none" },
        statusCodes: [200, 503],
        summary: "Checks application readiness without a response body.",
    },
] as const satisfies readonly RawHttpContract[];
