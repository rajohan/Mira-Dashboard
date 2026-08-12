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
        expect(first.get("README.md")).toContain(
            "[Browser routes and features](routes-and-features.md)"
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
        expect(configurationDocumentation).toContain(
            "| `ELEVENLABS_API_KEY` | `elevenLabsApiKey` | `opaque-secret`; values withheld | When present, a trimmed nonblank control-safe secret at most 4096 code units; never persisted, logged, or browser-exposed. | Optional; no default | `web` | Yes | None |"
        );
        expect(configurationDocumentation).toContain(
            "| `MIRA_DASHBOARD_DATABASE_OBSERVABILITY_URL` | `databaseObservabilityUrl` | `postgresql-url`; values withheld | Canonical postgresql URL for exact 127.0.0.1:6432/postgres with explicit user and password, no query or fragment, at most 4096 code units; never persisted, logged, or browser-exposed. | Optional; no default | `worker` | Yes | None |"
        );
        expect(configurationDocumentation).toContain(
            "| `MOLTBOOK_API_KEY` | `moltbookApiKey` | `opaque-secret`; values withheld | Trimmed nonblank control-safe secret at most 4096 code units; never persisted, logged, or browser-exposed. | Required; value withheld | `worker` | Yes | None |"
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
            "| `chat.send` | mutation | chat | Authenticated: chat:write |"
        );
        expect(procedureDocumentation).toContain(
            "| `chat.companionAsk` | mutation | chat | Authenticated: chat:write |"
        );
        expect(procedureDocumentation).toContain(
            "| `openClawTasks.cancel` | mutation | openClawTasks | Authenticated: openclaw-tasks:write |"
        );
        expect(procedureDocumentation).toContain(
            "| `files.list` | query | files | Authenticated browser session: files:read |"
        );
        expect(procedureDocumentation).toContain(
            "| `logs.tail` | query | logs | Authenticated browser session: logs:read |"
        );
        expect(procedureDocumentation).toContain(
            "| `moltbook.feed` | query | moltbook | Authenticated browser session: cache:read |"
        );
        expect(procedureDocumentation).toContain(
            "| `moltbook.snapshot` | query | moltbook | Authenticated browser session: cache:read |"
        );
        expect(procedureDocumentation).toContain(
            "| `terminal.prepareSession` | mutation | terminal | Authenticated browser session: terminal:write; MFA enrollment required; recent MFA when enabled |"
        );
        expect(procedureDocumentation).toContain(
            "| `serviceActions.getStatus` | query | service-actions | Authenticated browser session: service-actions:read |"
        );
        expect(procedureDocumentation).toContain(
            "| `serviceActions.request` | mutation | service-actions | Authenticated browser session: service-actions:write; MFA enrollment required; recent MFA when enabled |"
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
            "| GET | `/api/health/live` | Public | 200 | No body | [schema]"
        );
        expect(rawHttpDocumentation).toContain(
            "| HEAD | `/api/health/live` | Public | 200 | No body | No body | None |"
        );
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/health/ready` | Public | 200, 503 | No body | [schema]"
        );
        expect(rawHttpDocumentation).toContain(
            "| HEAD | `/api/health/ready` | Public | 200, 503 | No body | No body | None |"
        );
        expect(rawHttpDocumentation).toContain(
            "| PUT | `/api/chat/attachments/:ticketId/:attachmentId` | Authenticated: chat:write | 204, 400, 401, 403, 404, 405, 408, 429 | Buffered binary, at most 16777216 bytes"
        );
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/chat/media/:attachmentId?disposition={download,preview}` | Authenticated: chat:read | 200, 206, 400, 401, 403, 404, 405, 415, 416, 429, 502 | No body | Buffered binary, at most 16777216 bytes — `*/*` | Single byte range |"
        );
        expect(rawHttpDocumentation).toContain(
            "| HEAD | `/api/chat/media/:attachmentId?disposition={download,preview}` | Authenticated: chat:read | 200, 206, 400, 401, 403, 404, 405, 415, 416, 429, 502 | No body | No body | Single byte range |"
        );
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/chat/speech/capabilities` | Authenticated | 200, 400, 401, 403, 404, 405 | No body | [schema](./schemas/chat.speech.capabilities.output.schema.json) — `application/json` | None |"
        );
        expect(rawHttpDocumentation).toContain(
            "| POST | `/api/chat/speech/transcribe` | Authenticated: chat:write | 200, 400, 401, 403, 404, 405, 408, 413, 415, 429, 502, 503, 504 | Buffered binary, at most 8388608 bytes"
        );
        expect(rawHttpDocumentation).toContain(
            "| POST | `/api/chat/speech/synthesize` | Authenticated: chat:write | 200, 400, 401, 403, 404, 405, 408, 413, 415, 429, 502, 503, 504 | [schema](./schemas/chat.speech.synthesize.input.schema.json) — `application/json` | Buffered binary, at most 8388608 bytes — `audio/mpeg` | None |"
        );
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/files/content/:ticketId` | Authenticated browser session: files:read |"
        );
        expect(rawHttpDocumentation).toContain(
            "| PUT | `/api/files/uploads/:ticketId` | Authenticated browser session: files:write; MFA enrollment required; recent MFA when enabled |"
        );
        expect(rawHttpDocumentation).toContain(
            "| GET | `/api/terminal/sessions/:sessionId/socket` | Authenticated browser session: terminal:write; MFA enrollment required; recent MFA when enabled | 101, 400, 401, 403, 404, 405, 409, 410, 426, 429, 500, 503 |"
        );
        const routeDocumentation = first.get("routes-and-features.md");
        expect(routeDocumentation).toContain(
            "| `/files` | Browser session | Files | `files` |"
        );
        expect(routeDocumentation).toContain(
            "| `/logs` | Browser session | Logs | `logs` |"
        );
        expect(routeDocumentation).toContain(
            "| `/moltbook` | Browser session | Moltbook | `moltbook` |"
        );
        expect(routeDocumentation).toContain(
            "| `/database` | Browser session | Database | `database` |"
        );
        expect(routeDocumentation).toContain(
            "| `/settings` | Browser session | Settings | `settings` |"
        );
        expect(routeDocumentation).toContain(
            "| `/terminal` | Browser session | Terminal | `terminal` |"
        );
        expect(routeDocumentation?.match(/^\| `\//gmu)).toHaveLength(16);
        expect(first.has("schemas/files.upload.accepted.schema.json")).toBe(true);
        expect(first.has("schemas/logs.tail.output.schema.json")).toBe(true);
        expect(first.has("schemas/moltbook.feed.result.v1.schema.json")).toBe(true);
        expect(first.has("schemas/moltbook.snapshot.result.v1.schema.json")).toBe(true);
        expect(
            first.has("schemas/openClawSettings.getConfiguration.output.schema.json")
        ).toBe(true);
        expect(first.has("schemas/terminal.prepareSession.output.schema.json")).toBe(
            true
        );
        for (const artifact of [
            "schemas/serviceActions.getStatus.input.schema.json",
            "schemas/serviceActions.getStatus.output.schema.json",
            "schemas/serviceActions.request.input.schema.json",
            "schemas/serviceActions.request.output.schema.json",
        ]) {
            expect(first.has(artifact)).toBe(true);
        }
        expect(first.get("schemas/files.list.output.schema.json")).toContain(
            "rejects traversal names and path separators"
        );
        expect(first.get("schemas/logs.tail.output.schema.json")).toContain(
            "every redacted log line ID to be unique"
        );
        expect(first.get("schemas/terminal.getRuntime.output.schema.json")).toContain(
            "initial terminal path"
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
            ["chat.history", "chat.history"],
            ["chat.runtime", "chat.runtime"],
            ["gateway.connection", "gateway.connection.get"],
            ["gateway.sessions", "gatewaySessions.list"],
            ["openclaw-cron.records", "openClawCron.list"],
            ["openclaw.tasks", "openClawTasks.list"],
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
