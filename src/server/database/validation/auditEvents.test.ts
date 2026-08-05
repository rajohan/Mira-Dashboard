import { describe, expect, test } from "bun:test";

import * as v from "valibot";

import {
    auditEventInsertSchema,
    auditEventSelectSchema,
    auditMetadataMaximumBytes,
} from "./auditEvents.ts";
import { validAuditEventInsert } from "./testSupport/securityRows.ts";

describe("audit event row schemas", () => {
    test("accepts one immutable redacted audit event", () => {
        expect(v.parse(auditEventInsertSchema, validAuditEventInsert)).toEqual(
            validAuditEventInsert
        );
        expect(v.parse(auditEventSelectSchema, validAuditEventInsert)).toBeDefined();
    });

    test("requires an explicit nullable authenticator on insert", () => {
        const { authenticatorId: _authenticatorId, ...withoutAuthenticator } =
            validAuditEventInsert;

        expect(() => v.parse(auditEventInsertSchema, withoutAuthenticator)).toThrow();
    });

    test.each([
        { action: "Security.Session" },
        { action: "-login" },
        { action: "security.audit\0" },
        { actorId: "   " },
        { actorId: "user\0id" },
        { actorKind: "loopback" },
        { actorKind: "system" },
        { authenticatorId: "\t\n" },
        { id: `${validAuditEventInsert.id}\0` },
        { metadataJson: "[]" },
        { metadataJson: "not-json" },
        { metadataJson: '{"number":1e400}' },
        { metadataJson: '{"number":9007199254740993}' },
        { outcome: "unknown" },
        { requestId: "request\0id" },
        { targetId: "\u3000" },
        { targetType: ".session" },
        { targetType: "system\0" },
        { targetType: "Auth Session" },
    ])("rejects invalid audit event %#", (replacement) => {
        expect(() =>
            v.parse(auditEventInsertSchema, {
                ...validAuditEventInsert,
                ...replacement,
            })
        ).toThrow();
    });

    test("bounds metadata by UTF-8 bytes", () => {
        const oversized = JSON.stringify({
            value: "å".repeat(auditMetadataMaximumBytes),
        });
        expect(() =>
            v.parse(auditEventInsertSchema, {
                ...validAuditEventInsert,
                metadataJson: oversized,
            })
        ).toThrow();
    });

    test("bounds metadata structure depth", () => {
        const excessiveDepth = `${'{"nested":'.repeat(14)}null${"}".repeat(14)}`;

        expect(() =>
            v.parse(auditEventInsertSchema, {
                ...validAuditEventInsert,
                metadataJson: excessiveDepth,
            })
        ).toThrow();
    });

    test("canonicalizes duplicate metadata keys before insertion", () => {
        expect(
            v.parse(auditEventInsertSchema, {
                ...validAuditEventInsert,
                metadataJson: '{"number":1e400,"number":0}',
            }).metadataJson
        ).toBe('{"number":0}');
        expect(() =>
            v.parse(auditEventInsertSchema, {
                ...validAuditEventInsert,
                metadataJson: '{"number":0,"number":1e400}',
            })
        ).toThrow();
    });
});
