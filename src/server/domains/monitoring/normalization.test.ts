import { describe, expect, test } from "bun:test";

import {
    deriveIncidentFingerprint,
    MonitoringSnapshotValidationError,
    normalizeMonitoringSnapshot,
} from "./normalization.ts";

const runId = "019fcb96-0000-7000-8000-000000000001";

function snapshot() {
    return {
        completedAtMs: 2000,
        monitorKey: " Ops-Check:Primary ",
        problems: [
            {
                condition: " Pressure ",
                details: { freeBytes: 1024 },
                entityKey: " Filesystem:ROOT ",
                kind: " System ",
                severity: "warning" as "critical" | "error" | "info" | "warning",
                title: " Root filesystem pressure ",
            },
        ],
        report: {
            bodyMarkdown: "# Health",
            kind: " Heartbeat ",
            metadata: { attempt: 1 },
            source: " openclaw ",
            sourceJobId: " ops-check ",
            title: " System health ",
        },
        runId,
        startedAtMs: 1000,
    };
}

describe("monitoring snapshot normalization", () => {
    test("derives identity only from normalized semantic fields", () => {
        const first = normalizeMonitoringSnapshot(snapshot());
        const changedPresentation = snapshot();
        changedPresentation.completedAtMs = 3000;
        changedPresentation.problems[0] = {
            ...changedPresentation.problems[0]!,
            details: { freeBytes: 512 },
            severity: "critical",
            title: "Disk is almost full",
        };
        const second = normalizeMonitoringSnapshot(changedPresentation);

        expect(first.snapshot.monitorKey).toBe("ops-check:primary");
        expect(first.snapshot.problems[0]).toMatchObject({
            condition: "pressure",
            entityKey: "filesystem:root",
            kind: "system",
            title: "Root filesystem pressure",
        });
        expect(first.snapshot.problems[0]?.fingerprint).toBe(
            second.snapshot.problems[0]?.fingerprint
        );
        expect(first.submissionSha256).not.toBe(second.submissionSha256);
    });

    test("changes identity when any canonical tuple component changes", () => {
        const baseline = {
            condition: "pressure",
            entityKey: "filesystem:root",
            kind: "system",
        };
        const fingerprint = deriveIncidentFingerprint(baseline);

        expect(
            deriveIncidentFingerprint({ ...baseline, condition: "unavailable" })
        ).not.toBe(fingerprint);
        expect(
            deriveIncidentFingerprint({ ...baseline, entityKey: "filesystem:data" })
        ).not.toBe(fingerprint);
        expect(deriveIncidentFingerprint({ ...baseline, kind: "backup" })).not.toBe(
            fingerprint
        );
    });

    test("uses unambiguous canonical tuple serialization", () => {
        const first = deriveIncidentFingerprint({
            condition: "c",
            entityKey: "b-c",
            kind: "a",
        });
        const second = deriveIncidentFingerprint({
            condition: "b-c",
            entityKey: "a",
            kind: "c",
        });

        expect(first).not.toBe(second);
    });

    test("rejects normalized duplicate problems before repository work", () => {
        const duplicate = snapshot();
        duplicate.problems.push({
            ...duplicate.problems[0]!,
            condition: "pressure",
            entityKey: "filesystem:root",
            kind: "system",
        });

        expect(() => normalizeMonitoringSnapshot(duplicate)).toThrow(
            MonitoringSnapshotValidationError
        );
        expect(() => normalizeMonitoringSnapshot(duplicate)).toThrow(
            "cannot contain duplicate problem identities"
        );
    });

    test("reports the exact separator policy for each identifier kind", () => {
        const invalidSegment = snapshot();
        invalidSegment.problems[0]!.kind = "system:health";
        expect(() => normalizeMonitoringSnapshot(invalidSegment)).toThrow(
            "problem.kind must use lowercase alphanumeric segments with '.', '_', or '-' separators"
        );

        const invalidIdentifier = snapshot();
        invalidIdentifier.problems[0]!.entityKey = "filesystem/root";
        expect(() => normalizeMonitoringSnapshot(invalidIdentifier)).toThrow(
            "problem.entityKey must use lowercase alphanumeric segments with '.', '_', ':', or '-' separators"
        );
    });

    test("canonicalizes problem order and nested JSON key order for idempotency", () => {
        const baseline = snapshot();
        const first = {
            ...baseline,
            problems: [
                ...baseline.problems,
                {
                    condition: "overdue",
                    details: {
                        hours: 26,
                        targets: { secondary: false, primary: true },
                    },
                    entityKey: "backup:primary",
                    kind: "backup",
                    severity: "error",
                    title: "Primary backup overdue",
                },
            ],
            report: {
                ...baseline.report,
                metadata: { complete: true, counts: { failed: 1, healthy: 2 } },
            },
        };
        const reordered = {
            ...baseline,
            problems: [
                {
                    condition: "overdue",
                    details: {
                        targets: { primary: true, secondary: false },
                        hours: 26,
                    },
                    entityKey: "backup:primary",
                    kind: "backup",
                    severity: "error",
                    title: "Primary backup overdue",
                },
                baseline.problems[0]!,
            ],
            report: {
                ...baseline.report,
                metadata: {
                    counts: { healthy: 2, failed: 1 },
                    complete: true,
                },
            },
        };

        expect(normalizeMonitoringSnapshot(first).submissionSha256).toBe(
            normalizeMonitoringSnapshot(reordered).submissionSha256
        );
    });

    test("rejects non-JSON array holes and timestamps outside the Date range", () => {
        const baseline = snapshot();
        const sparseSamples: unknown[] = [null];
        Reflect.deleteProperty(sparseSamples, 0);
        const sparseDetails = {
            ...baseline,
            problems: [
                {
                    ...baseline.problems[0]!,
                    details: { samples: sparseSamples },
                },
            ],
        };

        expect(() => normalizeMonitoringSnapshot(sparseDetails)).toThrow(
            MonitoringSnapshotValidationError
        );
        expect(() =>
            normalizeMonitoringSnapshot({
                ...snapshot(),
                completedAtMs: 8_640_000_000_000_001,
            })
        ).toThrow(MonitoringSnapshotValidationError);
    });

    test("rejects malformed complete snapshots with a domain-safe error", () => {
        expect(() =>
            normalizeMonitoringSnapshot({ ...snapshot(), completedAtMs: 999 })
        ).toThrow(MonitoringSnapshotValidationError);
        expect(() =>
            normalizeMonitoringSnapshot({ ...snapshot(), problems: [{}] })
        ).toThrow(MonitoringSnapshotValidationError);
    });
});
