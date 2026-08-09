import * as v from "valibot";

import { timestampMillisecondsSchema } from "../shared/dateTime.ts";
import {
    boundedControlSafeTextSchema,
    boundedNonBlankTextSchema,
    hasUniqueArrayItems,
    lowercaseSha256Action,
    lowercaseSha256Schema,
    noNulStringAction,
    nonnegativeSafeIntegerSchema,
    positiveSafeIntegerSchema,
} from "../shared/validation.ts";
import { jobIdempotencyKeySchema, jobRunIdSchema } from "./jobModel.ts";
import type { ProcedureContract } from "./registry.ts";
import { emptyInputSchema } from "./system.ts";

/** Maximum number of operator-selectable sources in one complete catalog. */
export const logSourceMaximum = 64;
/** Maximum number of rows returned by one tail or search request. */
export const logRowMaximum = 500;
/** Default row count for the live tail. */
export const logTailDefaultRows = 200;
/** Maximum characters retained from one physical log line after redaction. */
export const logLineMaximumCharacters = 4096;
/** Maximum characters in one server-side search term. */
export const logSearchMaximumCharacters = 200;
/** Maximum bytes the reader may inspect from the end of one source per request. */
export const logReadWindowMaximumBytes = 4 * 1024 * 1024;

export const logSourceGroups = ["dashboard", "host", "openclaw"] as const;
export const logSourceGroupSchema = v.picklist(
    logSourceGroups,
    "Log source group is invalid"
);

export const logSourceIdSchema = v.pipe(
    v.string("Log source id is invalid"),
    v.minLength(1, "Log source id is invalid"),
    v.maxLength(128, "Log source id is invalid"),
    v.regex(/^[a-z0-9][a-z0-9._-]*$/u, "Log source id is invalid")
);

export const logSourceAvailabilitySchema = v.picklist(
    ["available", "missing", "unreadable"],
    "Log source availability is invalid"
);

export const logSourceSchema = v.strictObject({
    availability: logSourceAvailabilitySchema,
    group: logSourceGroupSchema,
    id: logSourceIdSchema,
    label: boundedControlSafeTextSchema(128, "Log source label is invalid"),
    modifiedAtMs: v.optional(
        timestampMillisecondsSchema("Log source modification time is invalid")
    ),
    sizeBytes: v.optional(nonnegativeSafeIntegerSchema("Log source size is invalid")),
});

/**
 * Applies runtime-only source-identity uniqueness validation.
 * @param sources Candidate named log sources.
 * @returns Whether every source ID is unique.
 */
export function logSourcesHaveUniqueIds(sources: LogSource[]): boolean {
    return hasUniqueArrayItems(sources.map(({ id }) => id));
}

const logSourceArraySchema = v.pipe(
    v.array(logSourceSchema, "Log sources are invalid"),
    v.maxLength(logSourceMaximum, "Log source catalog is outside its budget"),
    v.check(logSourcesHaveUniqueIds, "Log source ids must be unique")
);

export const listLogSourcesOutputSchema = v.strictObject({
    observedAtMs: timestampMillisecondsSchema("Log catalog timestamp is invalid"),
    sources: logSourceArraySchema,
});

const logLimitSchema = v.pipe(
    positiveSafeIntegerSchema("Log row limit is invalid"),
    v.maxValue(logRowMaximum, "Log row limit is outside its budget")
);

export const tailLogsInputSchema = v.strictObject({
    limit: v.optional(logLimitSchema, logTailDefaultRows),
    sourceId: logSourceIdSchema,
});

export const searchLogsInputSchema = v.strictObject({
    limit: v.optional(logLimitSchema, logTailDefaultRows),
    query: boundedNonBlankTextSchema(
        logSearchMaximumCharacters,
        "Log search query is invalid"
    ),
    sourceId: logSourceIdSchema,
});

export const logSeverities = [
    "trace",
    "debug",
    "info",
    "warn",
    "error",
    "fatal",
    "unknown",
] as const;
export const logSeveritySchema = v.picklist(logSeverities, "Log severity is invalid");

export const logLineIdSchema = v.pipe(
    v.string("Log line id is invalid"),
    v.length(64, "Log line id is invalid"),
    lowercaseSha256Action("Log line id is invalid")
);

export const logLineSchema = v.strictObject({
    id: logLineIdSchema,
    line: v.pipe(
        v.string("Log line is invalid"),
        v.maxLength(logLineMaximumCharacters, "Log line is outside its budget"),
        noNulStringAction("Log line is invalid")
    ),
    severity: logSeveritySchema,
    timestampMs: v.optional(timestampMillisecondsSchema("Log timestamp is invalid")),
});

/**
 * Applies runtime-only redacted line-identity uniqueness validation.
 * @param lines Candidate redacted log lines.
 * @returns Whether every line ID is unique.
 */
export function logLinesHaveUniqueIds(lines: LogLine[]): boolean {
    return hasUniqueArrayItems(lines.map(({ id }) => id));
}

const logLinesSchema = v.pipe(
    v.array(logLineSchema, "Log lines are invalid"),
    v.maxLength(logRowMaximum, "Log rows are outside their budget"),
    v.check(logLinesHaveUniqueIds, "Log line ids must be unique")
);

export const logSnapshotOutputSchema = v.strictObject({
    hasEarlier: v.boolean("Log continuation state is invalid"),
    lines: logLinesSchema,
    observedAtMs: timestampMillisecondsSchema("Log observation timestamp is invalid"),
    revision: lowercaseSha256Schema("Log revision is invalid"),
    scannedBytes: nonnegativeSafeIntegerSchema("Log scan size is invalid"),
    sourceId: logSourceIdSchema,
});

export const logMaintenancePolicyIds = [
    "docker-managed",
    "host-alternatives",
    "host-apport",
    "host-dpkg",
    "host-rsyslog",
] as const;
export const logMaintenancePolicyIdSchema = v.picklist(
    logMaintenancePolicyIds,
    "Log maintenance policy is invalid"
);

export const logMaintenancePolicyStatusSchema = v.strictObject({
    id: logMaintenancePolicyIdSchema,
    label: boundedControlSafeTextSchema(128, "Log maintenance policy label is invalid"),
    scope: v.picklist(["docker", "host"], "Log maintenance scope is invalid"),
    state: v.picklist(["queueable", "unavailable"], "Log maintenance state is invalid"),
});

/**
 * Applies runtime-only fixed-policy identity uniqueness validation.
 * @param policies Candidate fixed log-maintenance policies.
 * @returns Whether every policy ID is unique.
 */
export function logMaintenancePoliciesHaveUniqueIds(
    policies: LogMaintenancePolicyStatus[]
): boolean {
    return hasUniqueArrayItems(policies.map(({ id }) => id));
}

export const logMaintenanceStatusOutputSchema = v.strictObject({
    observedAtMs: timestampMillisecondsSchema("Log maintenance timestamp is invalid"),
    policies: v.pipe(
        v.array(logMaintenancePolicyStatusSchema, "Log maintenance policies are invalid"),
        v.length(
            logMaintenancePolicyIds.length,
            "Log maintenance policy inventory is incomplete"
        ),
        v.check(
            logMaintenancePoliciesHaveUniqueIds,
            "Log maintenance policies must be unique"
        )
    ),
});

export const requestLogMaintenanceInputSchema = v.strictObject({
    idempotencyKey: jobIdempotencyKeySchema,
    policyId: logMaintenancePolicyIdSchema,
});

export const requestLogMaintenanceOutputSchema = v.strictObject({
    jobRunId: jobRunIdSchema,
    policyId: logMaintenancePolicyIdSchema,
    queued: v.literal(true),
});

export type LogSource = v.InferOutput<typeof logSourceSchema>;
export type ListLogSourcesOutput = v.InferOutput<typeof listLogSourcesOutputSchema>;
export type TailLogsInput = v.InferOutput<typeof tailLogsInputSchema>;
export type SearchLogsInput = v.InferOutput<typeof searchLogsInputSchema>;
export type LogLine = v.InferOutput<typeof logLineSchema>;
export type LogSnapshotOutput = v.InferOutput<typeof logSnapshotOutputSchema>;
export type LogMaintenancePolicyId = v.InferOutput<typeof logMaintenancePolicyIdSchema>;
export type LogMaintenancePolicyStatus = v.InferOutput<
    typeof logMaintenancePolicyStatusSchema
>;
export type LogMaintenanceStatusOutput = v.InferOutput<
    typeof logMaintenanceStatusOutputSchema
>;
export type RequestLogMaintenanceInput = v.InferOutput<
    typeof requestLogMaintenanceInputSchema
>;
export type RequestLogMaintenanceOutput = v.InferOutput<
    typeof requestLogMaintenanceOutputSchema
>;

const logReadAccess = {
    capabilities: ["logs:read"],
    capabilityPolicy: "all",
    kind: "authenticated",
    principalKinds: ["session"],
} as const;
const logMaintenanceAccess = {
    capabilities: ["logs:write"],
    kind: "recent-auth",
    principalKinds: ["session"],
    whenMfaDisabled: "deny",
    whenMfaEnabled: "mfa",
} as const;
const logQueryTransport = {
    batching: "adapter-default",
    handler: "default",
    requestBody: "default",
} as const;
const logMutationTransport = {
    batching: "forbidden",
    handler: "default",
    requestBody: "default",
} as const;

export const logProcedureContracts = [
    {
        access: logReadAccess,
        domain: "logs",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "logs.listSources.input",
        kind: "query",
        name: "logs.listSources",
        output: listLogSourcesOutputSchema,
        outputSchemaId: "logs.listSources.output",
        summary: "Lists the bounded named log-source catalog without filesystem paths.",
        transport: logQueryTransport,
    },
    {
        access: logReadAccess,
        domain: "logs",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: tailLogsInputSchema,
        inputSchemaId: "logs.tail.input",
        kind: "query",
        name: "logs.tail",
        output: logSnapshotOutputSchema,
        outputSchemaId: "logs.tail.output",
        summary: "Reads one redacted bounded tail from an exact named source.",
        transport: logQueryTransport,
    },
    {
        access: logReadAccess,
        domain: "logs",
        errors: ["FORBIDDEN", "NOT_FOUND", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: searchLogsInputSchema,
        inputSchemaId: "logs.search.input",
        kind: "query",
        name: "logs.search",
        output: logSnapshotOutputSchema,
        outputSchemaId: "logs.search.output",
        summary: "Searches only a bounded redacted tail window of one named source.",
        transport: logQueryTransport,
    },
    {
        access: logReadAccess,
        domain: "logs",
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: emptyInputSchema,
        inputSchemaId: "logs.maintenanceStatus.input",
        kind: "query",
        name: "logs.maintenanceStatus",
        output: logMaintenanceStatusOutputSchema,
        outputSchemaId: "logs.maintenanceStatus.output",
        summary: "Reports which reviewed fixed log-maintenance policies can be queued.",
        transport: logQueryTransport,
    },
    {
        access: logMaintenanceAccess,
        domain: "logs",
        errorReasons: ["mfa_enrollment_required", "step_up_required"],
        errors: ["FORBIDDEN", "SERVICE_UNAVAILABLE", "UNAUTHORIZED"],
        input: requestLogMaintenanceInputSchema,
        inputSchemaId: "logs.requestMaintenance.input",
        kind: "mutation",
        name: "logs.requestMaintenance",
        output: requestLogMaintenanceOutputSchema,
        outputSchemaId: "logs.requestMaintenance.output",
        summary:
            "Queues one audited worker-owned invocation of an exact reviewed log policy.",
        transport: logMutationTransport,
    },
] as const satisfies readonly ProcedureContract[];
