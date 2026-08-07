import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    accountMfaSummarySchema,
    factorLabelMaximumLength,
    isValidFactorLabel,
    totpFactorLabelSchema,
} from "../../src/contracts/accountSecurity.ts";
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

    test("documents automation normalization and runtime-only cross-field checks", () => {
        expect(
            convertContractSchema(
                applicationCapabilityListSchema,
                "test.applicationCapabilities",
                "output"
            )
        ).toMatchObject({
            items: {
                enum: ["notifications:read", "reports:read", "tasks:read", "tasks:write"],
            },
            maxItems: 4,
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
    });
});
