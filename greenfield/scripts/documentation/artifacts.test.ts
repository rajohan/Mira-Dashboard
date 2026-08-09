import { describe, expect, test } from "bun:test";

import {
    realtimeStreamCapabilities,
    realtimeStreamTopics,
} from "../../src/contracts/events.ts";
import { realtimeSubscriptionMaximumTopics } from "../../src/contracts/realtime.ts";
import { buildDocumentationArtifacts } from "./artifacts.ts";

const packageManifest = {
    dependencies: {
        "@trpc/server": "11.18.0",
        valibot: "1.4.2",
    },
    devDependencies: {
        "@valibot/to-json-schema": "1.7.1",
        eventsource: "4.1.1",
    },
    resolvedVersions: {
        "@trpc/server": "11.18.0",
        "@valibot/to-json-schema": "1.7.1",
        eventsource: "4.1.1",
        valibot: "1.4.2",
    },
};

describe("generated contract documentation", () => {
    test("is deterministic and includes only registered contracts", () => {
        const first = buildDocumentationArtifacts(packageManifest);
        const second = buildDocumentationArtifacts(packageManifest);

        expect([...first]).toEqual([...second]);
        expect(first.get("README.md")).toContain("[tRPC procedures](procedures.md)");
        expect(first.get("README.md")).toContain(
            "[Application configuration](configuration.md)"
        );
        expect(first.get("README.md")).not.toContain(
            "database, configuration, and browser"
        );
        const configurationDocumentation = first.get("configuration.md");
        expect(configurationDocumentation).toContain(
            "| Environment | Typed field | Type / enumerated values | Validation constraints | Default behavior | Process roles | Secret | Browser exposure | Operational effect | Restart | Development/test overrides | Description |"
        );
        expect(configurationDocumentation).toContain(
            "| `MIRA_DASHBOARD_LOG_LEVEL` | `logLevel` | `log-level`; `debug`, `error`, `info`, `warn` | Exactly one enumerated structured-log level. | `info` | `web`, `worker`, `script` | No | Value |"
        );
        expect(configurationDocumentation).toContain(
            "| `MIRA_DASHBOARD_TOTP_KEYRING` | `totpKeyring` | `json-secret`; values withheld | Version 1 JSON with one to eight unique AES-256 keys and one active key, at most 4096 code units. | Required; value withheld | `web` | Yes | Presence only |"
        );
        const procedureDocumentation = first.get("procedures.md");
        expect(procedureDocumentation).toContain("`auth.bootstrap`");
        expect(procedureDocumentation).toContain("`auth.changePassword`");
        expect(procedureDocumentation).toContain("Authenticated browser session");
        expect(procedureDocumentation).toContain("Pending MFA login");
        expect(procedureDocumentation).toContain(
            "Browser session when MFA is disabled; recent MFA when enabled"
        );
        expect(procedureDocumentation).toContain(
            "Recent password when MFA is disabled; recent MFA when enabled"
        );
        expect(procedureDocumentation).toContain(
            "MFA enrollment required; recent MFA when enabled"
        );
        expect(procedureDocumentation).toContain(
            "`CONFLICT`, `SERVICE_UNAVAILABLE`, `TOO_MANY_REQUESTS`, `UNAUTHORIZED`"
        );
        expect(procedureDocumentation).toContain(
            "`mfa_enrollment_required`, `step_up_required`"
        );
        expect(procedureDocumentation).toContain("Client action reasons");
        expect(procedureDocumentation).toContain(
            "| `auth.status` | query | auth | Public |"
        );
        expect(procedureDocumentation).toContain(
            "| `agents.updateMetadata` | mutation | agents | Authenticated automation principal: agents:write |"
        );
        expect(procedureDocumentation).toContain(
            "| `gatewaySessions.compact` | mutation | gateway-sessions | Authenticated browser session: gateway-sessions:write; MFA enrollment required; recent MFA when enabled |"
        );
        expect(procedureDocumentation).toContain(
            "| `openClawCron.run` | mutation | openclaw-cron | Authenticated browser session: jobs:write; MFA enrollment required; recent MFA when enabled |"
        );
        expect(procedureDocumentation).toContain(
            "| None | None | Returns bootstrap, pending MFA"
        );
        expect(procedureDocumentation).toContain("`events.stream`");
        expect(procedureDocumentation).toContain(
            `Authenticated; per-topic: ${realtimeStreamCapabilities.join(", ")}`
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
        const realtimeDocumentation = first.get("realtime-events.md");
        for (const [topic, snapshot, idSchema] of [
            [
                "agents.status",
                "agents.listStatuses",
                {
                    maxLength: 64,
                    minLength: 1,
                    pattern: "^[a-z0-9][a-z0-9._-]*$",
                    type: "string",
                },
            ],
            [
                "jobs.runs",
                "jobs.listRuns",
                {
                    anyOf: [
                        {
                            format: "uuid",
                            maxLength: 36,
                            minLength: 36,
                            pattern:
                                "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                            type: "string",
                        },
                        {
                            maxLength: 80,
                            minLength: 1,
                            pattern: "^[a-z0-9][a-z0-9._-]*$",
                            type: "string",
                        },
                    ],
                },
            ],
            [
                "monitoring.incidents",
                "incidents.list",
                { maxLength: 200, pattern: "\\S", type: "string" },
            ],
            [
                "monitoring.notifications",
                "notifications.list",
                { maxLength: 200, pattern: "\\S", type: "string" },
            ],
            [
                "monitoring.reports",
                "reports.list",
                { maxLength: 200, pattern: "\\S", type: "string" },
            ],
            [
                "schedules.records",
                "schedules.list",
                {
                    anyOf: [
                        {
                            format: "uuid",
                            maxLength: 36,
                            minLength: 36,
                            pattern:
                                "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                            type: "string",
                        },
                        {
                            maxLength: 80,
                            minLength: 1,
                            pattern: "^[a-z0-9][a-z0-9._-]*$",
                            type: "string",
                        },
                    ],
                },
            ],
            [
                "tasks.records",
                "tasks.list",
                {
                    format: "uuid",
                    maxLength: 36,
                    minLength: 36,
                    pattern:
                        "^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
                    type: "string",
                },
            ],
        ] as const) {
            expect(realtimeDocumentation).toContain(
                `| \`${topic}\` | [payload](./schemas/${topic}.realtime.payload.schema.json) | \`${snapshot}\` | 7 days |`
            );
            const payloadSchema = JSON.parse(
                first.get(`schemas/${topic}.realtime.payload.schema.json`) ?? "null"
            ) as unknown;
            expect(payloadSchema).toMatchObject({
                $id: `urn:mira-dashboard:${topic}.realtime.payload`,
                additionalProperties: false,
                properties: { id: idSchema },
                required: ["id"],
                type: "object",
            });
        }
        for (const [topic, snapshot] of [
            ["gateway.connection", "gateway.connection.get"],
            ["gateway.sessions", "gatewaySessions.list"],
            ["openclaw-cron.records", "openClawCron.list"],
        ] as const) {
            expect(realtimeDocumentation).toContain(
                `| \`${topic}\` | [payload](./schemas/${topic}.realtime.payload.schema.json) | \`${snapshot}\` | 7 days |`
            );
            const payloadSchema = JSON.parse(
                first.get(`schemas/${topic}.realtime.payload.schema.json`) ?? "null"
            ) as unknown;
            expect(payloadSchema).toMatchObject({
                $id: `urn:mira-dashboard:${topic}.realtime.payload`,
                additionalProperties: false,
                properties: { kind: { const: "snapshot-required" } },
                required: ["kind"],
                type: "object",
            });
        }
        expect(realtimeDocumentation?.match(/^\| `/gmu)).toHaveLength(
            realtimeStreamTopics.length
        );
        expect(first.get("schemas/schedules.update.input.schema.json")).toContain(
            "Five-field minute cron; live validation accepts JAN-DEC month and SUN-SAT weekday aliases, normalizes aliases and ASCII whitespace, and requires a future occurrence."
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
        expect(realtimeInputSchema).toEqual(
            expect.objectContaining({
                additionalProperties: false,
                properties: expect.objectContaining({
                    lastEventId: expect.objectContaining({
                        default: "0",
                        type: "string",
                    }),
                    topics: {
                        items: {
                            enum: realtimeStreamTopics,
                            type: "string",
                        },
                        maxItems: realtimeSubscriptionMaximumTopics,
                        minItems: 1,
                        type: "array",
                        uniqueItems: true,
                    },
                }),
                required: ["topics"],
                type: "object",
            })
        );
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
