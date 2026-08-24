import type { Effect } from "effect";
import * as v from "valibot";

import { databaseObservabilityCacheKey } from "../../../contracts/database.ts";
import {
    type JobCancellationPolicy,
    type JobResourceClass,
    type JobRunResult,
    type ScheduleConfiguration,
    jobActionKeySchema,
    jobAttemptLimitSchema,
    jobCancellationPolicySchema,
    jobDescriptionSchema,
    jobDisplayNameSchema,
    jobPayloadSchema,
    jobPrioritySchema,
    jobResourceClassSchema,
    jobResourceKeysSchema,
    jobRunEventProgressSchema,
    jobTimestampSchema,
    jobTimeoutSchema,
    scheduleConfigurationSchema,
    scheduleIdSchema,
} from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import type { JsonObject } from "../../../shared/json.ts";
import { logMaintenanceJobActionKey } from "../../../shared/logMaintenanceUnits.ts";
import { boundedControlSafeTextSchema } from "../../../shared/validation.ts";

export type JobInitialDuePolicy = "immediate" | "next-occurrence";
export type JobManualExposure = "cache-internal" | "cache-write" | "jobs-write" | "none";
export type JobActionEventWriteResult = "appended" | "dropped" | "truncated";
export type JobCacheAttemptWriteResult = "committed" | "lost-claim";

export { logMaintenanceJobActionKey } from "../../../shared/logMaintenanceUnits.ts";
/** Automatic schedule runs only the custom managed application/container policy. */
export const logMaintenanceJobScheduleId = "maintenance.rotate-managed-logs";
/** Worker-only fixed-host Moltbook snapshot refresh identity. */
export const moltbookDashboardCacheJobActionKey = "cache.refresh.moltbook-dashboard";
/** Durable schedule identity for the all-or-nothing Moltbook projection. */
export const moltbookDashboardCacheJobScheduleId = "cache.moltbook-dashboard";
/** Worker-only direct-protocol PostgreSQL and PgBouncer snapshot refresh identity. */
export const databaseObservabilityCacheJobActionKey =
    "cache.refresh.database-observability";
/** Durable hourly schedule identity for the external database projection. */
export const databaseObservabilityCacheJobScheduleId = "cache.database-observability";
/** Fixed worker-only online SQLite backup and upkeep identity. */
export const sqliteMaintenanceJobActionKey = "database.sqlite-maintenance";
/** Durable daily SQLite backup and upkeep schedule identity. */
export const sqliteMaintenanceJobScheduleId = "database.sqlite-maintenance";
/** Worker-only dynamic action used for one already-spooled structural file write. */
export const workspaceFileWriteJobActionKey = "workspace-files.apply-write";
/** Retry-safe worker action backed by a durable replace intent and atomic exchange. */
export const workspaceFileReplaceJobActionKey = "workspace-files.apply-replacement";
/** Fixed non-retryable worker action for one operator-requested Gateway restart. */
export const openClawGatewayRestartJobActionKey = "openclaw.gateway.restart";
/** Fixed worker-only OpenClaw maintenance identity selected by Service Actions. */
export const openClawSessionsCleanupJobActionKey = "openclaw.sessions.cleanup";
/** Fixed worker-only OpenClaw update identity selected by Service Actions. */
export const openClawInstallationUpdateJobActionKey = "openclaw.installation.update";
/** Fixed root-brokered host cleanup identity selected by Service Actions. */
export const hostSystemCleanupJobActionKey = "host.system.cleanup";
/** Fixed root-brokered host restart identity selected by Service Actions. */
export const hostSystemRestartJobActionKey = "host.system.restart";
/** Fixed root-brokered host update identity selected by Service Actions. */
export const hostSystemUpdateJobActionKey = "host.system.update";

/** Secret-free terminal payload persisted by the fixed Gateway restart executor. */
export const openClawGatewayRestartJobResultSchema = v.strictObject({
    completedAtMs: jobTimestampSchema,
    status: v.literal("restarted", "OpenClaw Gateway restart result is invalid"),
});

/** Redacted accepted-only result for a host restart request. */
export const hostSystemRestartJobResultSchema = v.strictObject({
    completedAtMs: jobTimestampSchema,
    status: v.literal("accepted", "Host restart result is invalid"),
});

/** Redacted terminal result for one fixed host cleanup unit. */
export const hostSystemCleanupJobResultSchema = v.strictObject({
    completedAtMs: jobTimestampSchema,
    status: v.literal("completed", "Host cleanup result is invalid"),
});

/** Redacted terminal result for one fixed host update unit. */
export const hostSystemUpdateJobResultSchema = v.strictObject({
    completedAtMs: jobTimestampSchema,
    status: v.literal("completed", "Host update result is invalid"),
});

const openClawOperationCountSchema = v.pipe(
    v.number("OpenClaw operation count is invalid"),
    v.safeInteger("OpenClaw operation count is invalid"),
    v.minValue(0, "OpenClaw operation count is invalid")
);
const openClawOperationVersionSchema = v.pipe(
    v.string("OpenClaw operation version is invalid"),
    v.minLength(1, "OpenClaw operation version is invalid"),
    v.maxLength(128, "OpenClaw operation version is invalid"),
    v.regex(
        /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        "OpenClaw operation version is invalid"
    )
);

/** Aggregate-only result for source-owned OpenClaw session maintenance. */
export const openClawSessionsCleanupJobResultSchema = v.strictObject({
    artifactsRemoved: openClawOperationCountSchema,
    bytesFreed: openClawOperationCountSchema,
    completedAtMs: jobTimestampSchema,
    diskEntriesRemoved: openClawOperationCountSchema,
    diskFilesRemoved: openClawOperationCountSchema,
    dmScopesRetired: openClawOperationCountSchema,
    entriesAfter: openClawOperationCountSchema,
    entriesBefore: openClawOperationCountSchema,
    entriesCapped: openClawOperationCountSchema,
    entriesPruned: openClawOperationCountSchema,
    missingEntriesRemoved: openClawOperationCountSchema,
    modelRunsPruned: openClawOperationCountSchema,
    status: v.literal("completed", "OpenClaw cleanup result is invalid"),
    storesProcessed: openClawOperationCountSchema,
});

/** Version/status-only result for source-owned OpenClaw installation updates. */
export const openClawInstallationUpdateJobResultSchema = v.strictObject({
    afterVersion: v.optional(openClawOperationVersionSchema),
    beforeVersion: v.optional(openClawOperationVersionSchema),
    completedAtMs: jobTimestampSchema,
    status: v.picklist(["accepted", "completed"], "OpenClaw update result is invalid"),
});

export type JobCacheAttemptCommit =
    | {
          readonly durationMs: number;
          readonly failureCode: string;
          readonly failureMessage: string;
          readonly key: string;
          readonly kind: "failed";
      }
    | {
          readonly durationMs: number;
          readonly entries: readonly {
              readonly key: string;
              readonly metadata: JsonObject;
              readonly payload: JsonObject;
              readonly schemaId: string;
              readonly source: string;
              readonly ttlMs: number;
          }[];
          readonly kind: "succeeded";
      };

const jobManualExposureSchema = v.picklist(
    ["cache-internal", "cache-write", "jobs-write", "none"],
    "Job manual exposure is invalid"
);
const jobInitialDuePolicySchema = v.picklist(
    ["immediate", "next-occurrence"],
    "Job initial due policy is invalid"
);

/** Explicit action-owned classification for failures safe to retry from scratch. */
export class JobActionRetryableError extends Error {
    constructor(cause?: unknown) {
        super(
            "The job action reported a retryable failure",
            cause === undefined ? undefined : { cause }
        );
        this.name = "JobActionRetryableError";
    }
}

/** Explicit action-owned classification for irreversible effects with unknown settlement. */
export class JobActionOutcomeUnknownError extends Error {
    constructor() {
        super("The job action outcome is unknown");
        this.name = "JobActionOutcomeUnknownError";
    }
}

const jobActionOutputMessageSchema = v.pipe(
    boundedControlSafeTextSchema(4096, "Job action output is invalid"),
    v.check((message) => utf8ByteLength(message) <= 4096, "Job action output is invalid")
);

/** Safe execution context supplied by the worker without host or shell authority. */
export interface JobActionExecutionContext {
    readonly armHostRestartClaimFence: () => Promise<void>;
    readonly clearHostRestartClaimFence: () => Promise<void>;
    readonly commitCacheAttempt: (
        attempt: JobCacheAttemptCommit
    ) => Promise<JobCacheAttemptWriteResult>;
    readonly databaseReleaseId: string;
    readonly nowMs: () => number;
    readonly reportProgress: (
        progress: JsonObject
    ) => Effect.Effect<JobActionEventWriteResult, unknown>;
    readonly workerInstanceId: string;
    readonly writeOutput: (
        kind: "stderr" | "stdout",
        message: string
    ) => Effect.Effect<JobActionEventWriteResult, unknown>;
}

/** Code-owned action metadata reconciled into schedules and captured into each run. */
export interface JobExecutableActionDefinition {
    readonly actionKey: string;
    readonly attemptLimit: number;
    readonly cancellationPolicy: JobCancellationPolicy;
    readonly description: string;
    readonly displayName: string;
    readonly manualExposure: JobManualExposure;
    readonly priority: number;
    readonly resourceClass: JobResourceClass;
    readonly resourceKeys: readonly string[];
    readonly retrySafe: boolean;
    readonly timeoutMs: number;
}

/** Release-owned action whose fixed payload is reconciled into one durable schedule. */
export interface JobActionDefinition extends JobExecutableActionDefinition {
    readonly actionPayload: JsonObject;
    readonly defaultEnabled: boolean;
    readonly defaultSchedule: ScheduleConfiguration;
    readonly initialDue: JobInitialDuePolicy;
    readonly scheduleId: string;
}

/** Dynamic action accepted only through a domain-specific durable queue. */
export interface JobUnscheduledActionDefinition extends JobExecutableActionDefinition {
    readonly actionPayload?: never;
    readonly defaultEnabled?: never;
    readonly defaultSchedule?: never;
    readonly initialDue?: never;
    readonly scheduleId?: never;
}

/** Worker-owned authority for one exact action definition. */
export type JobActionExecutor = (
    context: JobActionExecutionContext,
    payload: JsonObject
) => Effect.Effect<JobRunResult, unknown>;

/** Worker-only cleanup that may run only after a successful claim is durably settled. */
export type JobActionSuccessfulSettlementHandler = (payload: JsonObject) => Promise<void>;

interface JobActionWorkerAuthority {
    readonly afterSuccessfulSettlement?: JobActionSuccessfulSettlementHandler;
    readonly execute: JobActionExecutor;
}

/** Combined definition and executor accepted only at the worker composition boundary. */
export type JobActionRegistration = (
    | JobActionDefinition
    | JobUnscheduledActionDefinition
) &
    JobActionWorkerAuthority;

function isScheduledJobActionRegistration(
    registration: JobActionRegistration
): registration is JobActionDefinition & JobActionWorkerAuthority {
    return registration.scheduleId !== undefined;
}

function validateExecutableActionDefinition<T extends JobExecutableActionDefinition>(
    definition: T
): T {
    v.parse(jobActionKeySchema, definition.actionKey);
    v.parse(jobAttemptLimitSchema, definition.attemptLimit);
    v.parse(jobCancellationPolicySchema, definition.cancellationPolicy);
    v.parse(jobDescriptionSchema, definition.description);
    v.parse(jobDisplayNameSchema, definition.displayName);
    v.parse(jobPrioritySchema, definition.priority);
    v.parse(jobResourceClassSchema, definition.resourceClass);
    const resourceKeys = v.parse(jobResourceKeysSchema, definition.resourceKeys);
    v.parse(jobManualExposureSchema, definition.manualExposure);
    v.parse(v.boolean("Job retry-safe flag is invalid"), definition.retrySafe);
    v.parse(jobTimeoutSchema, definition.timeoutMs);
    return Object.freeze({
        ...definition,
        resourceKeys: Object.freeze([...resourceKeys]),
    });
}

/**
 * Validates one code-owned action and retains canonical schedule output.
 * @param registration Candidate release-owned action metadata.
 * @returns A frozen registration safe for reconciliation and execution.
 */
export function validateJobActionDefinition(
    definition: JobActionDefinition
): JobActionDefinition {
    const executable = validateExecutableActionDefinition(definition);
    const actionPayload = v.parse(jobPayloadSchema, definition.actionPayload);
    v.parse(v.boolean("Job default-enabled flag is invalid"), definition.defaultEnabled);
    const defaultSchedule = v.parse(
        scheduleConfigurationSchema,
        definition.defaultSchedule
    );
    v.parse(jobInitialDuePolicySchema, definition.initialDue);
    v.parse(scheduleIdSchema, definition.scheduleId);
    return Object.freeze({
        ...executable,
        actionPayload: Object.freeze({ ...actionPayload }),
        defaultSchedule: Object.freeze({ ...defaultSchedule }),
    });
}

/**
 * Validates dynamic worker metadata that deliberately has no schedule identity.
 * @param definition Candidate unscheduled worker action.
 * @returns Frozen validated action metadata.
 */
export function validateJobUnscheduledActionDefinition(
    definition: JobUnscheduledActionDefinition
): JobUnscheduledActionDefinition {
    return validateExecutableActionDefinition(definition);
}

/**
 * Validates a worker-only combined registration without publishing it to web code.
 * @param registration Candidate action definition and worker executor.
 * @returns A frozen, validated worker action registration.
 */
export function validateJobActionRegistration(
    registration: JobActionRegistration
): JobActionRegistration {
    const definition = isScheduledJobActionRegistration(registration)
        ? validateJobActionDefinition(registration)
        : validateJobUnscheduledActionDefinition(registration);
    v.parse(v.function("Job action executor is invalid"), registration.execute);
    if (registration.afterSuccessfulSettlement !== undefined) {
        v.parse(
            v.function("Job action settlement handler is invalid"),
            registration.afterSuccessfulSettlement
        );
    }
    return Object.freeze({
        ...definition,
        ...(registration.afterSuccessfulSettlement === undefined
            ? {}
            : {
                  afterSuccessfulSettlement: registration.afterSuccessfulSettlement,
              }),
        execute: registration.execute,
    });
}

const workerSmokeDefinition = validateJobActionDefinition({
    actionKey: "system.worker-smoke",
    actionPayload: Object.freeze({}),
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    defaultEnabled: false,
    defaultSchedule: Object.freeze({
        intervalMs: 86_400_000,
        kind: "interval",
    }),
    description:
        "Verifies the release, database, and durable worker without host mutation.",
    displayName: "Worker smoke",
    initialDue: "next-occurrence",
    manualExposure: "jobs-write",
    priority: 0,
    resourceClass: "light",
    resourceKeys: Object.freeze(["database"]),
    retrySafe: true,
    scheduleId: "system.worker-smoke",
    timeoutMs: 30_000,
});

const systemHostCacheDefinition = validateJobActionDefinition({
    actionKey: "cache.refresh.system-host",
    actionPayload: Object.freeze({ key: "system.host" }),
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    defaultEnabled: true,
    defaultSchedule: Object.freeze({
        intervalMs: 86_400_000,
        kind: "interval",
    }),
    description: "Projects bounded host, memory, and root-filesystem status.",
    displayName: "System host cache",
    initialDue: "immediate",
    manualExposure: "cache-write",
    priority: 0,
    resourceClass: "light",
    resourceKeys: Object.freeze(["cache.system.host"]),
    retrySafe: true,
    scheduleId: "cache.system-host",
    timeoutMs: 30_000,
});

const moltbookDashboardCacheDefinition = validateJobActionDefinition({
    actionKey: moltbookDashboardCacheJobActionKey,
    actionPayload: Object.freeze({ key: "moltbook.dashboard" }),
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    defaultEnabled: true,
    defaultSchedule: Object.freeze({
        intervalMs: 30 * 60_000,
        kind: "interval",
    }),
    description:
        "Projects a bounded all-or-nothing Moltbook home, feed, profile, and authored-content snapshot.",
    displayName: "Moltbook dashboard cache",
    initialDue: "immediate",
    manualExposure: "cache-write",
    priority: 0,
    resourceClass: "light",
    resourceKeys: Object.freeze(["network.moltbook"]),
    retrySafe: true,
    scheduleId: moltbookDashboardCacheJobScheduleId,
    timeoutMs: 30_000,
});

const databaseObservabilityCacheDefinition = validateJobActionDefinition({
    actionKey: databaseObservabilityCacheJobActionKey,
    actionPayload: Object.freeze({ key: databaseObservabilityCacheKey }),
    attemptLimit: 3,
    cancellationPolicy: "cooperative",
    defaultEnabled: true,
    defaultSchedule: Object.freeze({
        intervalMs: 60 * 60_000,
        kind: "interval",
    }),
    description:
        "Projects a bounded read-only PostgreSQL and PgBouncer observability snapshot.",
    displayName: "Database observability cache",
    initialDue: "immediate",
    // Persists claim-fenced cache attempts without exposing this domain-only
    // payload through the generic cache read or manual-refresh procedures.
    manualExposure: "cache-internal",
    priority: 0,
    resourceClass: "host-heavy",
    resourceKeys: Object.freeze([
        "database.postgresql",
        "docker.engine",
        "network.database-observability",
    ]),
    retrySafe: true,
    scheduleId: databaseObservabilityCacheJobScheduleId,
    // Open/reconcile owns 300 seconds, collection owns 60 seconds, and
    // mandatory fail-closed cleanup owns 30 seconds. The remaining 30-second
    // margin preserves claim-fenced cache and job settlement time.
    timeoutMs: 7 * 60_000,
});

/** Daily online SQLite snapshot, restore verification, retention, and fixed upkeep. */
export const sqliteMaintenanceJobActionDefinition = validateJobActionDefinition({
    actionKey: sqliteMaintenanceJobActionKey,
    actionPayload: Object.freeze({}),
    attemptLimit: 1,
    cancellationPolicy: "never",
    defaultEnabled: true,
    defaultSchedule: Object.freeze({
        kind: "daily",
        timeOfDay: "02:40",
        timeZone: "Europe/Oslo",
    }),
    description:
        "Creates and verifies one immutable SQLite snapshot, applies bounded retention, and runs fixed SQLite upkeep.",
    displayName: "SQLite maintenance",
    initialDue: "next-occurrence",
    manualExposure: "none",
    priority: 0,
    resourceClass: "host-heavy",
    resourceKeys: Object.freeze(["database"]),
    retrySafe: false,
    scheduleId: sqliteMaintenanceJobScheduleId,
    timeoutMs: 16 * 60_000,
});

const logMaintenanceDefinition = validateJobActionDefinition({
    actionKey: logMaintenanceJobActionKey,
    actionPayload: Object.freeze({ policyId: "docker-managed" }),
    attemptLimit: 1,
    cancellationPolicy: "cooperative",
    defaultEnabled: true,
    defaultSchedule: Object.freeze({
        intervalMs: 15 * 60_000,
        kind: "interval",
    }),
    description:
        "Runs the fixed worker-owned managed log policy; reviewed host policies remain explicit operator requests.",
    displayName: "Managed log maintenance",
    initialDue: "immediate",
    manualExposure: "none",
    priority: 0,
    resourceClass: "host-heavy",
    resourceKeys: Object.freeze(["host.logs"]),
    retrySafe: false,
    scheduleId: logMaintenanceJobScheduleId,
    timeoutMs: 5 * 60_000,
});

/** Honest non-retryable create definition; its payload is supplied by the actor-bound Files queue. */
export const workspaceFileWriteJobActionDefinition =
    validateJobUnscheduledActionDefinition({
        actionKey: workspaceFileWriteJobActionKey,
        attemptLimit: 1,
        cancellationPolicy: "cooperative",
        description: "Creates one bounded descriptor-rooted workspace file.",
        displayName: "Workspace file create",
        manualExposure: "none",
        priority: 10,
        resourceClass: "host-heavy",
        resourceKeys: Object.freeze(["workspace.files"]),
        retrySafe: false,
        timeoutMs: 2 * 60_000,
    });

/** Durable-intent-backed replacement definition that can recover after worker restart. */
export const workspaceFileReplaceJobActionDefinition =
    validateJobUnscheduledActionDefinition({
        actionKey: workspaceFileReplaceJobActionKey,
        attemptLimit: 3,
        cancellationPolicy: "cooperative",
        description:
            "Replaces one bounded descriptor-rooted workspace file with durable CAS recovery.",
        displayName: "Workspace file replacement",
        manualExposure: "none",
        priority: 10,
        resourceClass: "host-heavy",
        resourceKeys: Object.freeze(["workspace.files"]),
        retrySafe: true,
        timeoutMs: 2 * 60_000,
    });

/** Exclusive non-cancellable action that must never be replayed after an uncertain claim. */
export const openClawGatewayRestartJobActionDefinition =
    validateJobUnscheduledActionDefinition({
        actionKey: openClawGatewayRestartJobActionKey,
        attemptLimit: 1,
        cancellationPolicy: "never",
        description:
            "Restarts the OpenClaw Gateway through one fixed worker-owned command.",
        displayName: "Restart OpenClaw Gateway",
        manualExposure: "none",
        priority: 20,
        resourceClass: "exclusive",
        resourceKeys: Object.freeze(["host.mutation", "openclaw.gateway"]),
        retrySafe: false,
        timeoutMs: 60_000,
    });

function serviceActionDefinition(input: {
    readonly actionKey: string;
    readonly description: string;
    readonly displayName: string;
    readonly resourceKeys?: readonly string[];
    readonly timeoutMs: number;
}): JobUnscheduledActionDefinition {
    return validateJobUnscheduledActionDefinition({
        ...input,
        attemptLimit: 1,
        cancellationPolicy: "never",
        manualExposure: "none",
        priority: 20,
        resourceClass: "exclusive",
        resourceKeys: Object.freeze(input.resourceKeys ?? ["host.mutation"]),
        retrySafe: false,
    });
}

/** Non-retryable source-owned OpenClaw session/artifact maintenance. */
export const openClawSessionsCleanupJobActionDefinition = serviceActionDefinition({
    actionKey: openClawSessionsCleanupJobActionKey,
    description:
        "Runs source-owned OpenClaw session and artifact maintenance with fixed enforcement policy.",
    displayName: "Clean up OpenClaw sessions",
    resourceKeys: Object.freeze(["host.mutation", "openclaw.gateway"]),
    timeoutMs: 10 * 60_000 + 30_000,
});

/** Non-retryable source-owned OpenClaw installation update and handoff. */
export const openClawInstallationUpdateJobActionDefinition = serviceActionDefinition({
    actionKey: openClawInstallationUpdateJobActionKey,
    description:
        "Runs the fixed OpenClaw installation update and managed restart handoff.",
    displayName: "Update OpenClaw",
    resourceKeys: Object.freeze(["host.mutation", "openclaw.gateway"]),
    timeoutMs: 35 * 60_000 + 30_000,
});

/** Non-retryable bounded host cleanup reserved for a separately privileged adapter. */
export const hostSystemCleanupJobActionDefinition = serviceActionDefinition({
    actionKey: hostSystemCleanupJobActionKey,
    description:
        "Cleans orphan packages and caches, bounded journal history, and unused Docker content older than seven days without deleting volumes.",
    displayName: "Clean up host system",
    resourceKeys: Object.freeze(["host.logs", "host.mutation"]),
    timeoutMs: 35 * 60_000,
});

/** Accepted-only host restart request reserved for a separately privileged adapter. */
export const hostSystemRestartJobActionDefinition = serviceActionDefinition({
    actionKey: hostSystemRestartJobActionKey,
    description: "Requests a host restart through a separately privileged fixed adapter.",
    displayName: "Restart host system",
    timeoutMs: 60_000,
});

/** Non-retryable host package update reserved for a separately privileged adapter. */
export const hostSystemUpdateJobActionDefinition = serviceActionDefinition({
    actionKey: hostSystemUpdateJobActionKey,
    description: "Runs a fixed host update through a separately privileged adapter.",
    displayName: "Update host system",
    timeoutMs: 2 * 60 * 60_000,
});

/** Complete reviewed pure-definition registry for this slice. */
export const jobActionDefinitions = Object.freeze([
    systemHostCacheDefinition,
    moltbookDashboardCacheDefinition,
    databaseObservabilityCacheDefinition,
    sqliteMaintenanceJobActionDefinition,
    logMaintenanceDefinition,
    workerSmokeDefinition,
]);

const definitionByKey = new Map(
    jobActionDefinitions.map((definition) => [definition.actionKey, definition])
);
if (definitionByKey.size !== jobActionDefinitions.length) {
    throw new Error("Job action definition registry contains duplicate action keys");
}
const definitionByScheduleId = new Map(
    jobActionDefinitions.map((definition) => [definition.scheduleId, definition])
);
if (definitionByScheduleId.size !== jobActionDefinitions.length) {
    throw new Error("Job action definition registry contains duplicate schedule IDs");
}

/**
 * Resolves one exact reviewed action.
 * @param actionKey Durable action identity.
 * @returns The action registration, when this release implements it.
 */
export function findJobActionDefinition(
    actionKey: string
): JobActionDefinition | undefined {
    return definitionByKey.get(actionKey);
}

/**
 * Checks that a durable schedule still belongs to the exact registered action.
 * @param scheduleId Durable schedule identity.
 * @param actionKey Durable action identity captured by the schedule.
 * @returns Whether this release owns the exact schedule/action pair.
 */
export function isRegisteredJobSchedule(scheduleId: string, actionKey: string): boolean {
    return definitionByScheduleId.get(scheduleId)?.actionKey === actionKey;
}

/**
 * Validates one action-owned progress payload before it reaches persistence.
 * @param progress Structured progress candidate.
 * @returns The bounded transport-safe payload.
 */
export function parseJobActionProgress(progress: JsonObject): JsonObject {
    return v.parse(jobRunEventProgressSchema, progress);
}

/**
 * Validates one action-owned output fragment before it reaches persistence.
 * @param message Human-readable output candidate.
 * @returns The bounded control-safe message.
 */
export function parseJobActionOutputMessage(message: string): string {
    return v.parse(jobActionOutputMessageSchema, message);
}
