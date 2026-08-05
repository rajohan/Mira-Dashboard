import { describe, expect, test } from "bun:test";

import { monitoringRealtimeTopics } from "../../src/contracts/monitoringRealtime.ts";
import { realtimeSubscriptionMaximumTopics } from "../../src/contracts/realtime.ts";
import { buildDocumentationArtifacts } from "./artifacts.ts";

const packageManifest = {
    dependencies: {
        "@trpc/server": "11.18.0",
        valibot: "1.4.2",
    },
    devDependencies: {
        "@valibot/to-json-schema": "1.7.1",
        eventsource: "4.1.0",
    },
    resolvedVersions: {
        "@trpc/server": "11.18.0",
        "@valibot/to-json-schema": "1.7.1",
        eventsource: "4.1.0",
        valibot: "1.4.2",
    },
};

describe("generated contract documentation", () => {
    test("is deterministic and includes only registered contracts", () => {
        const first = buildDocumentationArtifacts(packageManifest);
        const second = buildDocumentationArtifacts(packageManifest);

        expect([...first]).toEqual([...second]);
        expect(first.get("README.md")).toContain("[tRPC procedures](procedures.md)");
        const procedureDocumentation = first.get("procedures.md");
        expect(procedureDocumentation).toContain("`auth.bootstrap`");
        expect(procedureDocumentation).toContain("`auth.changePassword`");
        expect(procedureDocumentation).toContain("Authenticated browser session");
        expect(procedureDocumentation).toContain(
            "`CONFLICT`, `SERVICE_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `UNAUTHORIZED`"
        );
        expect(procedureDocumentation).toContain(
            "| `auth.status` | query | auth | Public |"
        );
        expect(procedureDocumentation).toContain("| None | Returns bootstrap state");
        expect(procedureDocumentation).toContain("`events.stream`");
        expect(procedureDocumentation).toContain(
            "Authenticated; per-topic: notifications:read, reports:read"
        );
        expect(procedureDocumentation).toContain("`system.runtimeIdentity`");
        const rawHttpDocumentation = first.get("raw-http.md");
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/health/live` | Public | 200 | [response]"
        );
        expect(rawHttpDocumentation).toContain(
            "| HEAD | `/api/health/live` | Public | 200 | No body |"
        );
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/health/ready` | Public | 200, 503 | [response]"
        );
        expect(rawHttpDocumentation).toContain(
            "| HEAD | `/api/health/ready` | Public | 200, 503 | No body |"
        );
        expect(first.get("realtime-events.md")).toContain(
            "No standalone realtime topic references are published"
        );
    });

    test("emits JSON Schema from the same Valibot transport schemas", () => {
        const artifacts = buildDocumentationArtifacts(packageManifest);
        const runtimeSchema = JSON.parse(
            artifacts.get("schemas/system.runtimeIdentity.output.schema.json") ?? "null"
        ) as unknown;

        expect(runtimeSchema).toMatchObject({
            $id: "urn:mira-dashboard:system.runtimeIdentity.output",
            $schema: "https://json-schema.org/draft/2020-12/schema",
            additionalProperties: false,
            required: ["revision", "version", "versionWithRevision"],
            type: "object",
        });
        const inputSchema = JSON.parse(
            artifacts.get("schemas/system.runtimeIdentity.input.schema.json") ?? "null"
        ) as unknown;
        expect(inputSchema).toMatchObject({
            additionalProperties: false,
            type: "object",
        });
        const realtimeInputSchema = JSON.parse(
            artifacts.get("schemas/events.stream.input.schema.json") ?? "null"
        ) as unknown;
        expect(realtimeInputSchema).toMatchObject({
            additionalProperties: false,
            properties: {
                topics: {
                    items: {
                        enum: Object.values(monitoringRealtimeTopics),
                        type: "string",
                    },
                    maxItems: realtimeSubscriptionMaximumTopics,
                    minItems: 1,
                    type: "array",
                    uniqueItems: true,
                },
            },
            required: ["topics"],
            type: "object",
        });
        expect(artifacts.get("packages-and-runtime.md")).toContain(
            "`@valibot/to-json-schema` | `1.7.1` | `1.7.1` | development"
        );
        expect(artifacts.get("packages-and-runtime.md")).toContain(
            "| Repository channel | `canary` |"
        );
        expect(artifacts.get("packages-and-runtime.md")).toContain(
            "| Required runtime version | `1.4.0` |"
        );
    });
});
