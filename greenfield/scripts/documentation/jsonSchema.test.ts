import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    accountMfaSummarySchema,
    factorLabelMaximumLength,
    isValidFactorLabel,
    totpFactorLabelSchema,
} from "../../src/contracts/accountSecurity.ts";
import {
    agentConfigurationSchema,
    agentStatusProjectionSchema,
} from "../../src/contracts/agentModel.ts";
import { listAgentTaskHistoryResultSchema } from "../../src/contracts/agents.ts";
import {
    authPasswordMaximumLength,
    authPasswordMinimumLength,
    browserSessionUserAgentMaximumLength,
    hasValidAuthPasswordLength,
    isValidBrowserSessionUserAgent,
} from "../../src/contracts/auth.ts";
import {
    automationCredentialSummarySchema,
    createAutomationPrincipalResultSchema,
    listAutomationPrincipalsResultSchema,
} from "../../src/contracts/automationSecurity.ts";
import { listIncidentsResultSchema } from "../../src/contracts/incidents.ts";
import { scheduleCronExpressionSchema } from "../../src/contracts/jobModel.ts";
import { jobRealtimeChangeSchemas } from "../../src/contracts/jobRealtime.ts";
import {
    completeMonitoringSnapshotInputSchema,
    monitoringJsonObjectSchema,
} from "../../src/contracts/monitoring.ts";
import { listNotificationsResultSchema } from "../../src/contracts/notifications.ts";
import { openClawCronJobSchema } from "../../src/contracts/openClawCron.ts";
import { listReportsResultSchema } from "../../src/contracts/reports.ts";
import { applicationCapabilityListSchema } from "../../src/contracts/security.ts";
import { listSecurityAuditEventsResultSchema } from "../../src/contracts/securityAudit.ts";
import {
    taskDetailSchema,
    taskLabelInputSchema,
    taskTitleSchema,
} from "../../src/contracts/taskModel.ts";
import {
    listTasksResultSchema,
    updateTaskInputSchema,
} from "../../src/contracts/tasks.ts";
import {
    webAuthnAuthenticationResponseSchema,
    webAuthnTransportListSchema,
} from "../../src/contracts/webauthn.ts";
import { jsonObjectSchema } from "../../src/shared/json.ts";
import {
    boundedNonBlankTextSchema,
    hasUniqueArrayItems,
} from "../../src/shared/validation.ts";
import { convertContractSchema } from "./jsonSchema.ts";

const parseHexadecimalCodePoint = (value: string): number => Number.parseInt(value, 16);

describe("contract JSON Schema conversion", () => {
    test("documents ASCII-bounded Unicode-mode regular expressions", () => {
        const schema = v.pipe(v.string(), v.regex(/^[a-z]+$/u));

        expect(convertContractSchema(schema, "test.regex", "input")).toMatchObject({
            pattern: "^[a-z]+$",
            type: "string",
        });
    });

    test("documents the named array uniqueness validator", () => {
        const schema = v.pipe(v.array(v.string()), v.check(hasUniqueArrayItems<string>));

        expect(convertContractSchema(schema, "test.unique", "input")).toMatchObject({
            type: "array",
            uniqueItems: true,
        });
    });

    test("documents WebAuthn transport bounds while keeping sorting runtime-only", () => {
        expect(
            convertContractSchema(
                webAuthnTransportListSchema,
                "test.webAuthnTransports",
                "output"
            )
        ).toMatchObject({
            items: {
                enum: ["ble", "cable", "hybrid", "internal", "nfc", "smart-card", "usb"],
            },
            maxItems: 7,
            type: "array",
            uniqueItems: true,
        });

        const undocumentedTransform = v.pipe(
            v.array(v.string()),
            v.transform((values) => values.toSorted())
        );
        expect(() =>
            convertContractSchema(
                undocumentedTransform,
                "test.unknownTransform",
                "output"
            )
        ).toThrow('The "transform" action cannot be converted to JSON Schema.');
    });

    test("documents accepted cron aliases before canonical normalization", () => {
        const schema = convertContractSchema(
            scheduleCronExpressionSchema,
            "test.scheduleCronExpression",
            "input"
        );

        expect(schema.description).toContain("JAN-DEC month");
        expect(schema.description).toContain("SUN-SAT weekday");
    });

    test("documents runtime-only realtime entity identity equality", () => {
        expect(
            convertContractSchema(
                jobRealtimeChangeSchemas[0],
                "test.jobRealtimeChange",
                "output"
            )
        ).toMatchObject({
            $comment:
                "Live Valibot validation additionally requires the realtime entity and compact payload IDs to match exactly.",
        });
    });

    test("documents the runtime-only OpenClaw cron projection invariants", () => {
        const document = JSON.stringify(
            convertContractSchema(openClawCronJobSchema, "test.openClawCronJob", "output")
        );

        expect(document).toContain(
            "delivery metadata and desired enabled-state synchronization"
        );
    });

    test("documents automation normalization and runtime-only cross-field checks", () => {
        expect(
            convertContractSchema(
                applicationCapabilityListSchema,
                "test.applicationCapabilities",
                "output"
            )
        ).toMatchObject({
            items: {
                enum: [
                    "agents:read",
                    "agents:write",
                    "cache:read",
                    "cache:write",
                    "gateway-sessions:read",
                    "gateway-sessions:write",
                    "jobs:read",
                    "jobs:write",
                    "monitoring:write",
                    "notifications:read",
                    "notifications:write",
                    "reports:read",
                    "reports:write",
                    "tasks:read",
                    "tasks:write",
                ],
            },
            maxItems: 15,
            type: "array",
            uniqueItems: true,
        });

        const credentialDocument = JSON.stringify(
            convertContractSchema(
                automationCredentialSummarySchema,
                "test.automationCredentialSummary",
                "output"
            )
        );
        expect(credentialDocument).toContain(
            "credential expiry after creation and revocation no earlier than creation"
        );
        expect(credentialDocument).toContain(
            "replacement credential to reference a different credential ID"
        );

        const pageDocument = JSON.stringify(
            convertContractSchema(
                listAutomationPrincipalsResultSchema,
                "test.automationPrincipalPage",
                "output"
            )
        );
        expect(pageDocument).toContain("strict newest-first ordering");
        expect(pageDocument).toContain("principal continuation cursor");

        const creationDocument = JSON.stringify(
            convertContractSchema(
                createAutomationPrincipalResultSchema,
                "test.createAutomationPrincipal",
                "output"
            )
        );
        expect(creationDocument).toContain("matching one-time token prefix");
    });

    test("documents runtime-only WebAuthn identifier equality", () => {
        expect(
            convertContractSchema(
                webAuthnAuthenticationResponseSchema,
                "test.webAuthnAuthenticationResponse",
                "input"
            )
        ).toMatchObject({
            $comment:
                "Live Valibot validation additionally requires id and rawId to match exactly.",
        });
    });

    test("documents the runtime-only aggregate possession-factor cap", () => {
        expect(
            convertContractSchema(
                accountMfaSummarySchema,
                "test.accountMfaSummary",
                "output"
            )
        ).toMatchObject({
            $comment:
                "Live Valibot validation additionally limits the combined TOTP and WebAuthn possession-factor inventory to four.",
        });
    });

    test("documents named Unicode code-point string budgets", () => {
        const passwordSchema = v.pipe(v.string(), v.check(hasValidAuthPasswordLength));
        const passwordDocument = convertContractSchema(
            passwordSchema,
            "test.password",
            "input"
        );
        expect(passwordDocument).toMatchObject({
            maxLength: authPasswordMaximumLength,
            minLength: authPasswordMinimumLength,
            type: "string",
        });
        const userAgentSchema = v.pipe(
            v.string(),
            v.check(isValidBrowserSessionUserAgent)
        );
        const userAgentDocument = convertContractSchema(
            userAgentSchema,
            "test.userAgent",
            "output"
        );
        expect(userAgentDocument).toMatchObject({
            maxLength: browserSessionUserAgentMaximumLength,
            minLength: 1,
            pattern: "^(?=[\\s\\S]*\\S)[^\\u0000]*$",
            type: "string",
        });
    });

    test("documents persistence-safe bounded text without losing constraints", () => {
        expect(
            convertContractSchema(
                boundedNonBlankTextSchema(4),
                "test.boundedText",
                "input"
            )
        ).toMatchObject({
            allOf: [{ pattern: "^[^\\u0000]*$" }],
            maxLength: 4,
            minLength: 1,
            pattern: "\\S",
            type: "string",
        });
    });

    test("documents security audit ordering and cursor refinements", () => {
        const document = JSON.stringify(
            convertContractSchema(
                listSecurityAuditEventsResultSchema,
                "test.securityAuditPage",
                "output"
            )
        );

        expect(document).toContain("strict newest-first audit-event ordering");
        expect(document).toContain("audit continuation cursor");
    });

    test("documents agent directory and task-history refinements", () => {
        const directoryDocument = JSON.stringify(
            convertContractSchema(
                agentConfigurationSchema,
                "test.agentConfiguration",
                "output"
            )
        );
        expect(directoryDocument).toContain("reviewed agent ID to be unique");

        const statusDocument = JSON.stringify(
            convertContractSchema(
                agentStatusProjectionSchema,
                "test.agentStatusProjection",
                "output"
            )
        );
        expect(statusDocument).toContain(
            "keeps Dashboard task state and Gateway session availability separate"
        );

        const historyDocument = JSON.stringify(
            convertContractSchema(
                listAgentTaskHistoryResultSchema,
                "test.agentTaskHistory",
                "output"
            )
        );
        expect(historyDocument).toContain("strict newest-first agent task-run ordering");
        expect(historyDocument).toContain("task-history cursor");
    });

    test("documents monitoring JSON, aggregate, ordering, and cursor constraints", () => {
        const jsonObjectDocument = convertContractSchema(
            jsonObjectSchema,
            "test.jsonObject",
            "input"
        );
        expect(jsonObjectDocument).toMatchObject({ type: "object" });
        expect(jsonObjectDocument.$comment).toContain("acyclic plain JSON object");

        const monitoringJsonDocument = convertContractSchema(
            monitoringJsonObjectSchema,
            "test.monitoringJsonObject",
            "input"
        );
        expect(monitoringJsonDocument).toMatchObject({ type: "object" });
        expect(monitoringJsonDocument.$comment).toContain("acyclic plain JSON object");
        expect(monitoringJsonDocument.$comment).toContain(
            "serialized JSON object to its reviewed UTF-8 byte budget"
        );

        const snapshotDocument = JSON.stringify(
            convertContractSchema(
                completeMonitoringSnapshotInputSchema,
                "test.monitoringSnapshot",
                "input"
            )
        );
        expect(snapshotDocument).toContain("snapshot completion not to precede");
        expect(snapshotDocument).toContain("aggregate UTF-8 byte budget");

        for (const [schema, schemaId, rowOrder, cursor] of [
            [
                listIncidentsResultSchema,
                "test.incidentPage",
                "strict newest-first incident ordering",
                "incident continuation cursor",
            ],
            [
                listNotificationsResultSchema,
                "test.notificationPage",
                "strict newest-first notification ordering",
                "notification continuation cursor",
            ],
            [
                listReportsResultSchema,
                "test.reportPage",
                "strict newest-first report ordering",
                "report continuation cursor",
            ],
        ] as const) {
            const document = JSON.stringify(
                convertContractSchema(schema, schemaId, "output")
            );
            expect(document).toContain(rowOrder);
            expect(document).toContain(cursor);
        }
    });

    test("documents task bounds, canonicalization, and runtime relationships", () => {
        const titleDocument = JSON.stringify(
            convertContractSchema(taskTitleSchema, "test.taskTitle", "input")
        );
        expect(titleDocument).toContain("canonical outer whitespace");
        expect(titleDocument).toContain("maxLength");

        expect(
            convertContractSchema(taskLabelInputSchema, "test.taskLabels", "input")
        ).toMatchObject({
            maxItems: 20,
            type: "array",
            uniqueItems: true,
        });

        expect(
            convertContractSchema(updateTaskInputSchema, "test.updateTask", "input")
        ).toMatchObject({
            properties: { patch: { minProperties: 1 } },
        });

        const detailDocument = JSON.stringify(
            convertContractSchema(taskDetailSchema, "test.taskDetail", "output")
        );
        expect(detailDocument).toContain("timestamps not to precede creation");
        const pageDocument = JSON.stringify(
            convertContractSchema(listTasksResultSchema, "test.taskPage", "output")
        );
        expect(pageDocument).toContain("strict newest-first task ordering");
        expect(pageDocument).toContain("task continuation cursor");
    });

    test("documents the exact TOTP factor-label predicate", () => {
        const document = convertContractSchema(
            totpFactorLabelSchema,
            "test.totpFactorLabel",
            "input"
        );
        expect(document).toMatchObject({
            maxLength: factorLabelMaximumLength,
            minLength: 1,
            type: "string",
        });
        if (typeof document.pattern !== "string") {
            throw new TypeError("TOTP factor-label JSON Schema pattern is missing");
        }
        const documentedPattern = new RegExp(document.pattern);
        const documentAccepts = (value: string): boolean => {
            let codePointLength = 0;
            for (const _codePoint of value) codePointLength += 1;
            return (
                codePointLength >= 1 &&
                codePointLength <= factorLabelMaximumLength &&
                documentedPattern.test(value)
            );
        };
        const expectParity = (value: string): void => {
            expect(documentAccepts(value)).toBe(isValidFactorLabel(value));
        };

        for (const value of [
            "Primary authenticator",
            ` ${String.fromCodePoint(parseHexadecimalCodePoint("00A0"))}Authenticator `,
            "😀".repeat(factorLabelMaximumLength),
            "\uD800",
            "",
            " ",
            String.fromCodePoint(
                parseHexadecimalCodePoint("00A0"),
                parseHexadecimalCodePoint("1680"),
                parseHexadecimalCodePoint("2000"),
                parseHexadecimalCodePoint("2028"),
                parseHexadecimalCodePoint("2029"),
                parseHexadecimalCodePoint("202F"),
                parseHexadecimalCodePoint("205F"),
                parseHexadecimalCodePoint("3000")
            ),
            "a".repeat(factorLabelMaximumLength + 1),
            "😀".repeat(factorLabelMaximumLength + 1),
        ]) {
            expectParity(value);
        }

        const controlOrFormatRanges = [
            ["0000", "001F"],
            ["007F", "009F"],
            ["00AD", "00AD"],
            ["0600", "0605"],
            ["061C", "061C"],
            ["06DD", "06DD"],
            ["070F", "070F"],
            ["0890", "0891"],
            ["08E2", "08E2"],
            ["180E", "180E"],
            ["200B", "200F"],
            ["202A", "202E"],
            ["2060", "2064"],
            ["2066", "206F"],
            ["FEFF", "FEFF"],
            ["FFF9", "FFFB"],
            ["110BD", "110BD"],
            ["110CD", "110CD"],
            ["13430", "1343F"],
            ["1BCA0", "1BCA3"],
            ["1D173", "1D17A"],
            ["E0001", "E0001"],
            ["E0020", "E007F"],
        ] as const;
        for (const [start, end] of controlOrFormatRanges) {
            for (
                let codePoint = parseHexadecimalCodePoint(start);
                codePoint <= parseHexadecimalCodePoint(end);
                codePoint += 1
            ) {
                expectParity(`safe${String.fromCodePoint(codePoint)}label`);
            }
        }
    });

    test("still rejects arbitrary checks without an explicit representation", () => {
        const schema = v.pipe(
            v.string(),
            v.check((value) => value !== "undocumented")
        );

        expect(() => convertContractSchema(schema, "test.unknown", "input")).toThrow(
            'The "check" action cannot be converted to JSON Schema.'
        );

        const customSchema = v.custom<Record<string, unknown>>(() => true);
        expect(() =>
            convertContractSchema(customSchema, "test.unknownCustom", "input")
        ).toThrow('The "custom" schema cannot be converted to JSON Schema.');
    });
});
