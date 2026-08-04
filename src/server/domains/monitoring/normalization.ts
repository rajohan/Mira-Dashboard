import { Schema } from "effect";
import * as v from "valibot";

import {
    completeMonitoringSnapshotInputSchema,
    type JsonObject,
} from "../../../contracts/monitoring.ts";
import { sha256Hex } from "../../shared/crypto.ts";

const fingerprintVersion = "monitoring-incident-fingerprint:v1";
const identifierPolicy = Object.freeze({
    pattern: /^[a-z0-9][a-z0-9._:-]*$/u,
    separators: "'.', '_', ':', or '-'",
});
const segmentPolicy = Object.freeze({
    pattern: /^[a-z0-9][a-z0-9._-]*$/u,
    separators: "'.', '_', or '-'",
});

function normalizedIdentifierSchema(
    label: string,
    policy: { readonly pattern: RegExp; readonly separators: string }
) {
    return v.pipe(
        v.string(),
        v.trim(),
        v.toLowerCase(),
        v.regex(
            policy.pattern,
            `${label} must use lowercase alphanumeric segments with ${policy.separators} separators`
        )
    );
}

const monitorKeySchema = normalizedIdentifierSchema("monitorKey", identifierPolicy);
const problemConditionSchema = normalizedIdentifierSchema(
    "problem.condition",
    segmentPolicy
);
const problemEntityKeySchema = normalizedIdentifierSchema(
    "problem.entityKey",
    identifierPolicy
);
const problemKindSchema = normalizedIdentifierSchema("problem.kind", segmentPolicy);
const reportKindSchema = normalizedIdentifierSchema("report.kind", segmentPolicy);
const trimmedTextSchema = v.pipe(v.string(), v.trim());

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
export class MonitoringSnapshotValidationError extends Schema.TaggedErrorClass<MonitoringSnapshotValidationError>(
    "mira-dashboard/server/domains/monitoring/MonitoringSnapshotValidationError"
)("MonitoringSnapshotValidationError", {
    message: Schema.String,
}) {}

function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== "object") {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new MonitoringSnapshotValidationError({
                message: "Monitoring snapshots must contain only JSON values",
            });
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

function parseNormalizedIdentifier(
    schema: v.GenericSchema<string, string>,
    value: string
): string {
    const validation = v.safeParse(schema, value);
    if (!validation.success) {
        throw new MonitoringSnapshotValidationError({
            message: validation.issues[0]?.message ?? "Invalid monitoring identifier",
        });
    }
    return validation.output;
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
    return sha256Hex(
        `${fingerprintVersion}\0${canonicalJson([
            input.kind,
            input.entityKey,
            input.condition,
        ])}`
    );
}

function compareIncidentFingerprints(
    left: Pick<NormalizedMonitoringProblem, "fingerprint">,
    right: Pick<NormalizedMonitoringProblem, "fingerprint">
): number {
    if (left.fingerprint < right.fingerprint) return -1;
    if (left.fingerprint > right.fingerprint) return 1;
    return 0;
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
        throw new MonitoringSnapshotValidationError({
            message: validation.issues[0]?.message ?? "Invalid complete monitor snapshot",
        });
    }
    const parsed = validation.output;
    const normalizedProblems = parsed.problems
        .map((problem): NormalizedMonitoringProblem => {
            const kind = parseNormalizedIdentifier(problemKindSchema, problem.kind);
            const entityKey = parseNormalizedIdentifier(
                problemEntityKeySchema,
                problem.entityKey
            );
            const condition = parseNormalizedIdentifier(
                problemConditionSchema,
                problem.condition
            );
            return {
                condition,
                details: problem.details,
                entityKey,
                fingerprint: deriveIncidentFingerprint({ condition, entityKey, kind }),
                kind,
                severity: problem.severity,
                title: v.parse(trimmedTextSchema, problem.title),
            };
        })
        .toSorted(compareIncidentFingerprints);

    const fingerprints = new Set(
        normalizedProblems.map((problem) => problem.fingerprint)
    );
    if (fingerprints.size !== normalizedProblems.length) {
        throw new MonitoringSnapshotValidationError({
            message:
                "A complete monitor snapshot cannot contain duplicate problem identities",
        });
    }

    const snapshot: NormalizedMonitoringSnapshot = {
        completedAtMs: parsed.completedAtMs,
        monitorKey: parseNormalizedIdentifier(monitorKeySchema, parsed.monitorKey),
        problems: normalizedProblems,
        report: {
            bodyMarkdown: parsed.report.bodyMarkdown,
            kind: parseNormalizedIdentifier(reportKindSchema, parsed.report.kind),
            metadata: parsed.report.metadata,
            source: v.parse(trimmedTextSchema, parsed.report.source),
            sourceJobId: v.parse(trimmedTextSchema, parsed.report.sourceJobId),
            title: v.parse(trimmedTextSchema, parsed.report.title),
        },
        runId: parsed.runId,
        startedAtMs: parsed.startedAtMs,
    };

    return {
        snapshot,
        submissionSha256: sha256Hex(canonicalJson(snapshot)),
    };
}
