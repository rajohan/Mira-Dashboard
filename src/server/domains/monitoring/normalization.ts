import * as v from "valibot";

import {
    completeMonitoringSnapshotInputSchema,
    type JsonObject,
} from "../../../contracts/monitoring.ts";

const fingerprintVersion = "monitoring-incident-fingerprint:v1";
const identifierPattern = /^[a-z0-9][a-z0-9._:-]*$/u;
const segmentPattern = /^[a-z0-9][a-z0-9._-]*$/u;

export interface NormalizedMonitoringProblem {
    condition: string;
    details: JsonObject;
    entityKey: string;
    fingerprint: string;
    kind: string;
    severity: "critical" | "error" | "info" | "warning";
    title: string;
}

export interface NormalizedMonitoringSnapshot {
    completedAtMs: number;
    monitorKey: string;
    problems: readonly NormalizedMonitoringProblem[];
    report: {
        bodyMarkdown: string;
        kind: string;
        metadata: JsonObject;
        source: string;
        sourceJobId: string;
        title: string;
    };
    runId: string;
    startedAtMs: number;
}

export interface NormalizedMonitoringSubmission {
    snapshot: NormalizedMonitoringSnapshot;
    submissionSha256: string;
}

/** Expected validation failure before the monitoring repository is entered. */
export class MonitoringSnapshotValidationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "MonitoringSnapshotValidationError";
    }
}

function sha256(value: string): string {
    return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new MonitoringSnapshotValidationError(
                "Monitoring snapshots must contain only JSON values"
            );
        }
        return serialized;
    }
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    }

    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
        .toSorted()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
        .join(",")}}`;
}

function normalizeIdentifier(value: string, label: string, pattern: RegExp): string {
    const normalized = value.trim().toLowerCase();
    if (!pattern.test(normalized)) {
        throw new MonitoringSnapshotValidationError(
            `${label} must use lowercase alphanumeric segments with '.', '_', ':', or '-' separators`
        );
    }
    return normalized;
}

/**
 * Derives a stable versioned identity from semantic problem fields only.
 * Presentation text, severity, details, and timestamps intentionally do not participate.
 * @param input Canonical problem identity components.
 * @returns Versioned lowercase SHA-256 fingerprint.
 */
export function deriveIncidentFingerprint(input: {
    condition: string;
    entityKey: string;
    kind: string;
}): string {
    return sha256(
        `${fingerprintVersion}\0${canonicalJson([
            input.kind,
            input.entityKey,
            input.condition,
        ])}`
    );
}

/**
 * Validates and normalizes one complete snapshot before any database access.
 * @param input Untrusted transport input.
 * @returns Canonical submission plus its idempotency checksum.
 */
export function normalizeMonitoringSnapshot(
    input: unknown
): NormalizedMonitoringSubmission {
    const validation = v.safeParse(completeMonitoringSnapshotInputSchema, input);
    if (!validation.success) {
        throw new MonitoringSnapshotValidationError(
            validation.issues[0]?.message ?? "Invalid complete monitor snapshot"
        );
    }
    const parsed = validation.output;
    const normalizedProblems = parsed.problems
        .map((problem): NormalizedMonitoringProblem => {
            const kind = normalizeIdentifier(
                problem.kind,
                "problem.kind",
                segmentPattern
            );
            const entityKey = normalizeIdentifier(
                problem.entityKey,
                "problem.entityKey",
                identifierPattern
            );
            const condition = normalizeIdentifier(
                problem.condition,
                "problem.condition",
                segmentPattern
            );
            return {
                condition,
                details: problem.details,
                entityKey,
                fingerprint: deriveIncidentFingerprint({ condition, entityKey, kind }),
                kind,
                severity: problem.severity,
                title: problem.title.trim(),
            };
        })
        .toSorted((left, right) => left.fingerprint.localeCompare(right.fingerprint));

    const fingerprints = new Set(
        normalizedProblems.map((problem) => problem.fingerprint)
    );
    if (fingerprints.size !== normalizedProblems.length) {
        throw new MonitoringSnapshotValidationError(
            "A complete monitor snapshot cannot contain duplicate problem identities"
        );
    }

    const snapshot: NormalizedMonitoringSnapshot = {
        completedAtMs: parsed.completedAtMs,
        monitorKey: normalizeIdentifier(
            parsed.monitorKey,
            "monitorKey",
            identifierPattern
        ),
        problems: normalizedProblems,
        report: {
            bodyMarkdown: parsed.report.bodyMarkdown,
            kind: normalizeIdentifier(parsed.report.kind, "report.kind", segmentPattern),
            metadata: parsed.report.metadata,
            source: parsed.report.source.trim(),
            sourceJobId: parsed.report.sourceJobId.trim(),
            title: parsed.report.title.trim(),
        },
        runId: parsed.runId,
        startedAtMs: parsed.startedAtMs,
    };

    return {
        snapshot,
        submissionSha256: sha256(canonicalJson(snapshot)),
    };
}
