import { getTime, toDate } from "date-fns";
import {
    and,
    asc,
    count,
    desc,
    eq,
    gte,
    gt,
    inArray,
    isNotNull,
    isNull,
    lt,
    lte,
    min,
    or,
    sql,
    type SQL,
} from "drizzle-orm";
import type { SQLiteBunDatabase } from "drizzle-orm/bun-sqlite";
import * as v from "valibot";

import {
    jobActionKeySchema,
    jobPayloadMaximumBytes,
    jobPayloadSchema,
    jobRunEventMaximum,
    jobRunEventMessageMaximumBytes,
    jobRunPayloadEventMaximum,
    jobRunPayloadEventMaximumBytes,
    jobResourceClasses,
    jobResourceKeysSchema,
    jobRunStates,
    jobTimestampSchema,
    jobWorkerSummaryMaximum,
    type JobResourceClass,
    type JobRunState,
    type ScheduleConfiguration,
} from "../../../contracts/jobModel.ts";
import {
    jobRunEventPageMaximum,
    jobRunPageMaximum,
    type ListJobRunsInput,
} from "../../../contracts/jobs.ts";
import {
    schedulePageMaximum,
    type ListScheduleRunsInput,
    type ListSchedulesInput,
} from "../../../contracts/schedules.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import {
    logMaintenanceJobActionKey,
    logMaintenanceJobPayloadIndexMaximumBytes,
} from "../../../shared/logMaintenanceUnits.ts";
import { fullCommitShaSchema } from "../../../shared/validation.ts";
import type { ImmediateDatabaseWriteAdmission } from "../../database/immediateWriteAdmission.ts";
import { auditEvents } from "../../database/schema/auditEvents.ts";
import { jobDisableIntents } from "../../database/schema/jobDisableIntents.ts";
import { jobRunEvents } from "../../database/schema/jobRunEvents.ts";
import { jobRuns } from "../../database/schema/jobRuns.ts";
import { jobWorkerControl } from "../../database/schema/jobWorkerControl.ts";
import { realtimeEvents } from "../../database/schema/realtime.ts";
import { resourceLeases } from "../../database/schema/resourceLeases.ts";
import { scheduledJobs } from "../../database/schema/scheduledJobs.ts";
import { workerInstances } from "../../database/schema/workerInstances.ts";
import { auditEventInsertSchema } from "../../database/validation/auditEvents.ts";
import {
    jobDisableIntentCloseSchema,
    jobDisableIntentInsertSchema,
    jobDisableIntentSelectSchema,
} from "../../database/validation/jobDisableIntents.ts";
import {
    jobRunEventInsertSchema,
    jobRunEventSelectSchema,
} from "../../database/validation/jobRunEvents.ts";
import {
    jobRunInsertSchema,
    jobRunSelectSchema,
} from "../../database/validation/jobRuns.ts";
import {
    jobWorkerControlSelectSchema,
    jobWorkerControlUpdateSchema,
} from "../../database/validation/jobWorkerControl.ts";
import { realtimeEventInsertSchema } from "../../database/validation/realtimeEvents.ts";
import {
    resourceLeaseInsertSchema,
    resourceLeaseSelectSchema,
} from "../../database/validation/resourceLeases.ts";
import {
    scheduledJobInsertSchema,
    scheduledJobSelectSchema,
} from "../../database/validation/scheduledJobs.ts";
import {
    canonicalWorkerActionKeys,
    parseWorkerActionKeysJson,
    workerActionKeysSchema,
} from "../../database/validation/workerActionKeys.ts";
import {
    workerInstanceInsertSchema,
    workerInstanceSelectSchema,
} from "../../database/validation/workerInstances.ts";
import type { SecurityAuditEvent } from "../security/audit.ts";
import {
    type JobDisableIntentRecord,
    type JobRunEventRecord,
    type JobRunRecord,
    type JobWorkerControlRecord,
    type ScheduledJobRecord,
    type WorkerInstanceRecord,
} from "./records.ts";

type TransactionCallback = Parameters<SQLiteBunDatabase["transaction"]>[0];
type JobTransaction = Parameters<TransactionCallback>[0];
type JobPersistenceDatabase = JobTransaction | SQLiteBunDatabase;

export type JobDisableIntentInsert = v.InferOutput<typeof jobDisableIntentInsertSchema>;
export type JobDisableIntentClose = v.InferOutput<typeof jobDisableIntentCloseSchema>;
export type JobRunInsert = v.InferOutput<typeof jobRunInsertSchema>;
export type JobRunEventInsert = v.InferOutput<typeof jobRunEventInsertSchema>;
export type JobRealtimeEventInsert = v.InferOutput<typeof realtimeEventInsertSchema>;
export type ScheduledJobInsert = v.InferOutput<typeof scheduledJobInsertSchema>;
export type WorkerInstanceInsert = v.InferOutput<typeof workerInstanceInsertSchema>;

export interface JobMutationSideEffects {
    readonly auditEvents: readonly SecurityAuditEvent[];
    readonly realtimeEvents: readonly JobRealtimeEventInsert[];
}

export interface ScheduleRecordWithRelations {
    readonly activeDisableIntent?: JobDisableIntentRecord;
    readonly activeRun?: JobRunRecord;
    readonly latestRun?: JobRunRecord;
    readonly schedule: ScheduledJobRecord;
}

export interface JobQueueWorkerRecord {
    readonly activeRunCount: number;
    readonly worker: WorkerInstanceRecord;
}

export interface JobQueueState {
    readonly activeResourceClasses: readonly JobResourceClass[];
    readonly control: JobWorkerControlRecord;
    readonly oldestQueuedAt?: Date;
    readonly stateCounts: Readonly<Record<JobRunState, number>>;
    readonly workers: readonly JobQueueWorkerRecord[];
}

/** Constant-size queue and worker aggregates consumed only by health diagnostics. */
export interface JobHealthState {
    readonly control: JobWorkerControlRecord;
    readonly oldestQueuedAt?: Date;
    readonly queuedRunCount: number;
    readonly runningRunCount: number;
    readonly workers: {
        readonly capacity: number;
        readonly drainingCount: number;
        readonly exactReleaseOnline: boolean;
        readonly freshCount: number;
        readonly onlineCount: number;
    };
}

export interface ReadJobHealthStateInput {
    readonly expectedReleaseId?: string;
    readonly minimumHeartbeatAt: Date;
}

export interface ReadWorkerActionAvailabilityInput {
    readonly actionKeys: readonly string[];
    readonly expectedReleaseId: string;
    readonly minimumHeartbeatAt: Date;
}

/** Narrow exact-release executable-action inventory reader. */
export interface WorkerActionAvailabilityReader {
    readWorkerActionAvailability(
        input: ReadWorkerActionAvailabilityInput
    ): readonly string[];
}

/** Narrow aggregate reader kept separate from the ordinary job-service repository port. */
export interface JobHealthStateReader {
    readHealthState(input: ReadJobHealthStateInput): JobHealthState;
}

export interface ListJobRunEventsInput {
    readonly beforeSequence?: number;
    readonly limit: number;
    readonly runId: string;
}

export interface JobRunDetailRecord {
    readonly events: readonly JobRunEventRecord[];
    readonly run: JobRunRecord;
}

export interface ListDueSchedulesInput {
    readonly at: Date;
    readonly cursor?: {
        readonly id: string;
        readonly nextRunAt: Date;
    };
    readonly limit?: number;
}

export interface ListActiveActionPayloadsInput {
    readonly actionKey: string;
    readonly limit: number;
}

/** Bounded active payload page used by durable resource reconciliation. */
export interface ActiveActionPayloadPage {
    readonly payloads: readonly string[];
    readonly truncated: boolean;
}

export interface ReadActionPayloadRunSnapshotsInput {
    readonly actionKey: string;
    readonly payloadJsons: readonly string[];
}

/** Latest active and terminal runs for one exact canonical action payload. */
export interface ActionPayloadRunSnapshot {
    readonly activeRun?: JobRunRecord;
    readonly lastRun?: JobRunRecord;
    readonly payloadJson: string;
}

export interface ReadQueueStateInput {
    readonly minimumHeartbeatAt: Date;
}

export interface ListJobRunsWithQueueStateInput extends ListJobRunsInput {
    readonly minimumHeartbeatAt: Date;
}

export interface ReconcileSchedulesInput {
    readonly at: Date;
    readonly retiredRunCancellation?: {
        readonly actor: JobActor;
        readonly sideEffectsForRun: (run: JobRunRecord) => JobMutationSideEffects;
        readonly terminalCode: string;
        readonly terminalMessage: string;
    };
    readonly schedules: readonly ScheduledJobInsert[];
    readonly sideEffectsForSchedule: (
        schedule: ScheduledJobRecord
    ) => JobMutationSideEffects;
}

export interface EnqueueManualRunInput extends JobMutationSideEffects {
    readonly queuedEvent: JobRunEventInsert;
    readonly rejectWhenActionActive?: boolean;
    readonly run: JobRunInsert;
}

export type EnqueueManualRunResult =
    | { readonly kind: "active"; readonly run: JobRunRecord }
    | { readonly kind: "action-unavailable" }
    | { readonly kind: "idempotency-mismatch"; readonly run: JobRunRecord }
    | { readonly kind: "inserted"; readonly run: JobRunRecord }
    | { readonly kind: "replayed"; readonly run: JobRunRecord };

export interface ScheduleUpdateChanges {
    readonly enabled?: boolean;
    readonly nextRunAt?: Date | null;
    readonly schedule?: ScheduleConfiguration;
}

export interface ScheduleQueuedCancellation {
    readonly at: Date;
    readonly terminalCode: string;
    readonly terminalMessage: string;
}

export interface UpdateScheduleRepositoryInput extends JobMutationSideEffects {
    readonly at: Date;
    readonly closeActiveIntent?: JobDisableIntentClose;
    readonly expectedActiveDisableIntentId: string | null;
    readonly expectedVersion: number;
    readonly id: string;
    readonly insertDisableIntent?: JobDisableIntentInsert;
    readonly patch: ScheduleUpdateChanges;
    readonly queuedCancellation?: ScheduleQueuedCancellation;
    readonly queuedCancellationSideEffects?: (
        run: JobRunRecord
    ) => JobMutationSideEffects;
}

export type UpdateScheduleRepositoryResult =
    | { readonly kind: "cancellation-not-supported"; readonly run: JobRunRecord }
    | { readonly kind: "not-found" }
    | { readonly kind: "updated"; readonly schedule: ScheduledJobRecord }
    | { readonly kind: "version-changed"; readonly schedule: ScheduledJobRecord };

export interface DueScheduleEnqueueInput extends JobMutationSideEffects {
    readonly at: Date;
    readonly nextRunAt: Date;
    readonly observedNextRunAt: Date;
    readonly rejectWhenActionActive?: boolean;
    readonly run: JobRunInsert;
    readonly scheduleId: string;
}

export type DueScheduleEnqueueResult =
    | { readonly kind: "active"; readonly run: JobRunRecord }
    | { readonly kind: "inserted"; readonly run: JobRunRecord }
    | { readonly kind: "not-due" }
    | { readonly kind: "not-found" }
    | { readonly kind: "state-changed"; readonly schedule: ScheduledJobRecord };

export interface JobActor {
    readonly id: string;
    readonly kind: "automation" | "system" | "user";
}

export interface JobOperatorActor {
    readonly id: string;
    readonly kind: "automation" | "user";
}

export interface CancelRunRepositoryInput {
    readonly actor: JobActor;
    readonly at: Date;
    readonly id: string;
    readonly sideEffectsForRun: (run: JobRunRecord) => JobMutationSideEffects;
    readonly terminalCode: string;
    readonly terminalMessage: string;
}

export type CancelRunRepositoryResult =
    | { readonly kind: "cancelled"; readonly run: JobRunRecord }
    | { readonly kind: "not-found" }
    | { readonly kind: "requested"; readonly run: JobRunRecord }
    | { readonly kind: "terminal"; readonly run: JobRunRecord }
    | { readonly kind: "unsupported"; readonly run: JobRunRecord };

export interface SetClaimingPausedRepositoryInput extends JobMutationSideEffects {
    readonly actor: JobOperatorActor;
    readonly at: Date;
    readonly expectedVersion: number;
    readonly paused: boolean;
}

export type SetClaimingPausedRepositoryResult =
    | { readonly control: JobWorkerControlRecord; readonly kind: "updated" }
    | { readonly control: JobWorkerControlRecord; readonly kind: "version-changed" };

export interface RegisterWorkerInput extends JobMutationSideEffects {
    readonly worker: WorkerInstanceInsert;
}

export interface WorkerLifecycleInput {
    readonly at: Date;
    readonly workerId: string;
}

export interface WorkerLifecycleMutationInput extends WorkerLifecycleInput {
    readonly sideEffectsForWorker: (
        worker: WorkerInstanceRecord
    ) => JobMutationSideEffects;
}

export type WorkerLifecycleResult =
    | { readonly kind: "active-runs"; readonly worker: WorkerInstanceRecord }
    | { readonly kind: "not-found" }
    | { readonly kind: "state-changed"; readonly worker: WorkerInstanceRecord }
    | { readonly kind: "updated"; readonly worker: WorkerInstanceRecord };

export interface RecoverExpiredClaimsInput {
    readonly at: Date;
    readonly limit?: number;
    readonly retryAt: (run: JobRunRecord) => Date;
    readonly sideEffectsForRun: (run: JobRunRecord) => JobMutationSideEffects;
}

export interface ExpireDisableIntentsInput {
    readonly at: Date;
    readonly canReenableSchedule: (schedule: ScheduledJobRecord) => boolean;
    readonly limit?: number;
    readonly nextRunAt: (schedule: ScheduledJobRecord, after: Date) => Date | undefined;
    readonly sideEffectsForSchedule: (
        schedule: ScheduledJobRecord,
        intent: JobDisableIntentRecord
    ) => JobMutationSideEffects;
    readonly systemActorId: string;
}

export type ExpireDisableIntentResult =
    | {
          readonly intent: JobDisableIntentRecord;
          readonly kind: "left-disabled";
          readonly schedule: ScheduledJobRecord;
      }
    | {
          readonly intent: JobDisableIntentRecord;
          readonly kind: "next-occurrence-unavailable";
          readonly schedule: ScheduledJobRecord;
      }
    | {
          readonly intent: JobDisableIntentRecord;
          readonly kind: "re-enabled";
          readonly schedule: ScheduledJobRecord;
      };

export interface JobClaimCursor {
    readonly availableAt: Date;
    readonly availableThrough: Date;
    readonly id: string;
    readonly priority: number;
    readonly queuedAt: Date;
}

export interface ClaimNextRunInput {
    readonly at: Date;
    readonly cursor?: JobClaimCursor;
    readonly leaseExpiresAt: Date;
    readonly leaseToken: string;
    readonly minimumHeartbeatAt: Date;
    readonly sideEffectsForClaim: (run: JobRunRecord) => JobMutationSideEffects;
    readonly workerId: string;
}

export type JobClaimResult =
    | { readonly kind: "claimed"; readonly run: JobRunRecord }
    | { readonly kind: "empty" }
    | {
          readonly cursor: JobClaimCursor;
          readonly kind: "page-exhausted";
      }
    | { readonly kind: "paused" }
    | { readonly kind: "worker-unavailable" };

export interface ClaimFenceInput {
    readonly at: Date;
    readonly leaseToken: string;
    readonly runId: string;
    readonly workerId: string;
}

export interface RenewClaimInput extends ClaimFenceInput {
    readonly leaseExpiresAt: Date;
}

export type JobClaimMutationResult =
    | { readonly kind: "lost-claim" }
    | { readonly kind: "renewed"; readonly run: JobRunRecord };

export interface JobClaimCancellation {
    readonly cancelRequested: boolean;
    readonly valid: boolean;
}

export interface AppendClaimEventInput extends ClaimFenceInput {
    readonly kind: "progress" | "stderr" | "stdout";
    readonly message?: string;
    readonly progressJson?: string;
    readonly sideEffectsForRun: (run: JobRunRecord) => JobMutationSideEffects;
}

export type JobAppendEventResult =
    | { readonly event: JobRunEventRecord; readonly kind: "appended" }
    | { readonly event?: JobRunEventRecord; readonly kind: "truncated" }
    | { readonly kind: "dropped" }
    | { readonly kind: "lost-claim" };

export type JobClaimOutcome =
    | {
          readonly kind: "cancelled";
          readonly terminalCode: string;
          readonly terminalMessage: string;
      }
    | {
          readonly kind: "failed";
          readonly retryAt?: Date;
          readonly terminalCode: string;
          readonly terminalMessage: string;
      }
    | { readonly kind: "succeeded"; readonly resultJson: string }
    | {
          readonly kind: "timed-out";
          readonly terminalCode: string;
          readonly terminalMessage: string;
      };

export interface SettleClaimInput extends ClaimFenceInput {
    readonly outcome: JobClaimOutcome;
    readonly sideEffectsForRun: (run: JobRunRecord) => JobMutationSideEffects;
}

export type JobSettlementResult =
    | { readonly kind: "lost-claim" }
    | { readonly kind: "retry-scheduled"; readonly run: JobRunRecord }
    | { readonly kind: "settled"; readonly run: JobRunRecord };

export interface JobRepositoryReader {
    findActiveDisableIntent(scheduleId: string): JobDisableIntentRecord | undefined;
    findActiveRunForSchedule(scheduleId: string): JobRunRecord | undefined;
    findLatestRunForSchedule(scheduleId: string): JobRunRecord | undefined;
    findRun(id: string): JobRunRecord | undefined;
    findRunByIdempotency(
        requestedByKind: JobRunRecord["requestedByKind"],
        requestedById: string,
        idempotencyKey: string
    ): JobRunRecord | undefined;
    findRunDetail(input: ListJobRunEventsInput): JobRunDetailRecord | undefined;
    findSchedule(id: string): ScheduleRecordWithRelations | undefined;
    listDueSchedules(input: ListDueSchedulesInput): ScheduledJobRecord[];
    listActiveActionPayloads(
        input: ListActiveActionPayloadsInput
    ): ActiveActionPayloadPage;
    listRunEvents(input: ListJobRunEventsInput): JobRunEventRecord[];
    listRuns(input: ListJobRunsInput): JobRunRecord[];
    listRunsWithQueueState(input: ListJobRunsWithQueueStateInput): JobRunPageSnapshot;
    listScheduleRuns(input: ListScheduleRunsInput): JobRunRecord[];
    listSchedules(input: ListSchedulesInput): ScheduleRecordWithRelations[];
    readClaimCancellation(input: ClaimFenceInput): JobClaimCancellation;
    readActionPayloadRunSnapshots(
        input: ReadActionPayloadRunSnapshotsInput
    ): readonly ActionPayloadRunSnapshot[];
    readQueueState(input: ReadQueueStateInput): JobQueueState;
    readWorkerControl(): JobWorkerControlRecord;
}

/** One run page and queue summary read from the same SQLite snapshot. */
export interface JobRunPageSnapshot {
    readonly queue: JobQueueState;
    readonly runs: readonly JobRunRecord[];
}

export interface JobRepository extends JobRepositoryReader {
    appendClaimEvent(input: AppendClaimEventInput): Promise<JobAppendEventResult>;
    beginWorkerDrain(input: WorkerLifecycleMutationInput): Promise<WorkerLifecycleResult>;
    cancelRun(input: CancelRunRepositoryInput): Promise<CancelRunRepositoryResult>;
    claimNextRun(input: ClaimNextRunInput): Promise<JobClaimResult>;
    enqueueManualRun(input: EnqueueManualRunInput): Promise<EnqueueManualRunResult>;
    enqueueNextDueSchedule(
        input: DueScheduleEnqueueInput
    ): Promise<DueScheduleEnqueueResult>;
    expireDisableIntents(
        input: ExpireDisableIntentsInput
    ): Promise<readonly ExpireDisableIntentResult[]>;
    heartbeatWorker(
        input: WorkerLifecycleInput
    ): Promise<WorkerInstanceRecord | undefined>;
    reconcileSchedules(input: ReconcileSchedulesInput): Promise<ScheduledJobRecord[]>;
    recoverExpiredClaims(
        input: RecoverExpiredClaimsInput
    ): Promise<readonly JobRunRecord[]>;
    registerWorker(input: RegisterWorkerInput): Promise<WorkerInstanceRecord>;
    renewClaim(input: RenewClaimInput): Promise<JobClaimMutationResult>;
    setClaimingPaused(
        input: SetClaimingPausedRepositoryInput
    ): Promise<SetClaimingPausedRepositoryResult>;
    settleClaim(input: SettleClaimInput): Promise<JobSettlementResult>;
    stopWorker(input: WorkerLifecycleMutationInput): Promise<WorkerLifecycleResult>;
    updateSchedule(
        input: UpdateScheduleRepositoryInput
    ): Promise<UpdateScheduleRepositoryResult>;
}

const claimCandidateMaximum = 32;
const recoveryBatchMaximum = 32;
const activeActionPayloadMaximum = 256;
const actionPayloadRunSnapshotMaximum = 32;
const activeRunStateList = [
    "queued",
    "running",
] as const satisfies readonly JobRunState[];
const terminalRunStateList = [
    "cancelled",
    "failed",
    "succeeded",
    "timed-out",
] as const satisfies readonly JobRunState[];
// SQLite partial-index matching requires the same literal state predicates as the DDL.
function literalStateList(states: readonly JobRunState[]): SQL {
    return sql.raw(states.map((state) => `'${state}'`).join(", "));
}
const activeStateFilter = sql`${jobRuns.state} IN (${literalStateList(activeRunStateList)})`;
const terminalStateFilter = sql`${jobRuns.state} IN (${literalStateList(terminalRunStateList)})`;
const logMaintenanceSnapshotScopeFilter = sql`${jobRuns.actionKey} = ${sql.raw(`'${logMaintenanceJobActionKey}'`)} AND length(CAST(${jobRuns.payloadJson} AS BLOB)) <= ${sql.raw(String(logMaintenanceJobPayloadIndexMaximumBytes))}`;
const terminalRunStates = new Set<JobRunState>(terminalRunStateList);

function requiredRow<T>(row: T | undefined, operation: string): T {
    if (row === undefined) {
        throw new Error(`Jobs repository ${operation} returned no row`);
    }
    return row;
}

function requiredValue<T>(value: T | null | undefined, operation: string): T {
    if (value === null || value === undefined) {
        throw new Error(`Jobs repository ${operation} returned no value`);
    }
    return value;
}

type InternalRunEventInput = Pick<
    JobRunEventInsert,
    "attempt" | "kind" | "occurredAt" | "workerInstanceId"
> & {
    readonly message?: string | null;
    readonly progressJson?: string | null;
};

function parseRun(row: unknown): JobRunRecord {
    return v.parse(jobRunSelectSchema, row);
}

function parseEvent(row: unknown): JobRunEventRecord {
    return v.parse(jobRunEventSelectSchema, row);
}

function parseSchedule(row: unknown): ScheduledJobRecord {
    return v.parse(scheduledJobSelectSchema, row);
}

function runMatchesScheduleExecutionSnapshot(
    run: JobRunInsert,
    schedule: ScheduledJobRecord
): boolean {
    return (
        run.scheduledJobId === schedule.id &&
        run.scheduledJobVersion === schedule.version &&
        run.actionKey === schedule.actionKey &&
        run.payloadJson === schedule.actionPayloadJson &&
        run.displayName === schedule.name &&
        run.resourceClass === schedule.resourceClass &&
        run.resourceKeysJson === schedule.resourceKeysJson &&
        run.priority === schedule.priority &&
        run.timeoutMs === schedule.timeoutMs &&
        run.attemptLimit === schedule.attemptLimit &&
        run.retrySafe === schedule.retrySafe &&
        run.cancellationPolicy === schedule.cancellationPolicy
    );
}

function parseDisableIntent(row: unknown): JobDisableIntentRecord {
    return v.parse(jobDisableIntentSelectSchema, row);
}

function parseWorker(row: unknown): WorkerInstanceRecord {
    return v.parse(workerInstanceSelectSchema, row);
}

function assertLimit(limit: number, maximum: number, operation: string): void {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
        throw new RangeError(`Jobs repository ${operation} limit is invalid`);
    }
}

function maximumDate(...dates: readonly Date[]): Date {
    return toDate(Math.max(...dates.map((date) => getTime(date))));
}

function boundedStructuralMessage(message: string): string {
    let byteLength = 0;
    let bounded = "";
    for (const codePoint of message) {
        const codePointBytes = utf8ByteLength(codePoint);
        if (byteLength + codePointBytes > jobRunEventMessageMaximumBytes) break;
        bounded += codePoint;
        byteLength += codePointBytes;
    }
    return bounded;
}

function shiftDurationToStart(
    requestedStart: Date,
    requestedEnd: Date,
    effectiveStart: Date
): Date {
    const duration = getTime(requestedEnd) - getTime(requestedStart);
    if (duration <= 0) {
        throw new RangeError("Job lease duration must be positive");
    }
    const shifted = toDate(getTime(effectiveStart) + duration);
    if (Number.isNaN(getTime(shifted))) {
        throw new RangeError("Job lease expiry is not representable");
    }
    return shifted;
}

function resourceKeys(record: Pick<JobRunRecord, "resourceKeysJson">): string[] {
    return v.parse(jobResourceKeysSchema, parseJsonText(record.resourceKeysJson));
}

function runCursorBoundary(
    input: ListJobRunsInput | ListScheduleRunsInput
): SQL | undefined {
    if (input.cursor === undefined) return undefined;
    const queuedAt = toDate(input.cursor.queuedAtMs);
    return or(
        lt(jobRuns.queuedAt, queuedAt),
        and(eq(jobRuns.queuedAt, queuedAt), lt(jobRuns.id, input.cursor.id))
    );
}

function runFilterConditions(input: ListJobRunsInput): SQL[] {
    const filters = input.filters;
    if (filters === undefined) return [];
    return [
        ...(filters.resourceClasses === undefined
            ? []
            : [inArray(jobRuns.resourceClass, [...filters.resourceClasses])]),
        ...(filters.scheduleId === undefined
            ? []
            : [eq(jobRuns.scheduledJobId, filters.scheduleId)]),
        ...(filters.states === undefined
            ? []
            : [inArray(jobRuns.state, [...filters.states])]),
        ...(filters.triggerTypes === undefined
            ? []
            : [inArray(jobRuns.triggerType, [...filters.triggerTypes])]),
    ];
}

function terminalStateForOutcome(
    outcome: JobClaimOutcome
): Exclude<JobRunState, "queued" | "running"> {
    switch (outcome.kind) {
        case "succeeded": {
            return "succeeded";
        }
        case "timed-out": {
            return "timed-out";
        }
        case "cancelled": {
            return "cancelled";
        }
        case "failed": {
            return "failed";
        }
    }
}

function effectiveSettlementOutcome(
    run: JobRunRecord,
    requested: JobClaimOutcome
): JobClaimOutcome {
    if (
        run.cancelRequestedAt === null ||
        requested.kind === "cancelled" ||
        requested.kind === "succeeded"
    ) {
        return requested;
    }
    return {
        kind: "cancelled",
        terminalCode: "cancel-requested",
        terminalMessage: "The job action was cancelled.",
    };
}

class DrizzleJobReader implements JobRepositoryReader {
    protected readonly database: JobPersistenceDatabase;

    public constructor(database: JobPersistenceDatabase) {
        this.database = database;
    }

    public findActiveDisableIntent(
        scheduleId: string
    ): JobDisableIntentRecord | undefined {
        const row = this.database
            .select()
            .from(jobDisableIntents)
            .where(
                and(
                    eq(jobDisableIntents.scheduledJobId, scheduleId),
                    isNull(jobDisableIntents.endedAt)
                )
            )
            .get();
        return row === undefined ? undefined : parseDisableIntent(row);
    }

    public findActiveRunForSchedule(scheduleId: string): JobRunRecord | undefined {
        const row = this.database
            .select()
            .from(jobRuns)
            .where(
                and(
                    eq(jobRuns.scheduledJobId, scheduleId),
                    inArray(jobRuns.state, ["queued", "running"])
                )
            )
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public findLatestRunForSchedule(scheduleId: string): JobRunRecord | undefined {
        const row = this.database
            .select()
            .from(jobRuns)
            .where(eq(jobRuns.scheduledJobId, scheduleId))
            .orderBy(desc(jobRuns.queuedAt), desc(jobRuns.id))
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public findRun(id: string): JobRunRecord | undefined {
        const row = this.database.select().from(jobRuns).where(eq(jobRuns.id, id)).get();
        return row === undefined ? undefined : parseRun(row);
    }

    public findRunByIdempotency(
        requestedByKind: JobRunRecord["requestedByKind"],
        requestedById: string,
        idempotencyKey: string
    ): JobRunRecord | undefined {
        const row = this.database
            .select()
            .from(jobRuns)
            .where(
                and(
                    eq(jobRuns.requestedByKind, requestedByKind),
                    eq(jobRuns.requestedById, requestedById),
                    eq(jobRuns.idempotencyKey, idempotencyKey)
                )
            )
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    public listActiveActionPayloads(
        input: ListActiveActionPayloadsInput
    ): ActiveActionPayloadPage {
        const actionKey = v.parse(jobActionKeySchema, input.actionKey);
        assertLimit(input.limit, activeActionPayloadMaximum, "active action payload");
        const rows = this.database
            .select({ payloadJson: jobRuns.payloadJson })
            .from(jobRuns)
            .where(
                and(
                    eq(jobRuns.actionKey, actionKey),
                    inArray(jobRuns.state, ["queued", "running"])
                )
            )
            .orderBy(desc(jobRuns.state), desc(jobRuns.queuedAt), desc(jobRuns.id))
            .limit(input.limit + 1)
            .all();
        return {
            payloads: rows.slice(0, input.limit).map(({ payloadJson }) => payloadJson),
            truncated: rows.length > input.limit,
        };
    }

    /**
     * Executes every bounded payload lookup inside this reader's one deferred snapshot.
     * @returns Input-ordered active and terminal observations for each payload.
     */
    public readActionPayloadRunSnapshots(
        input: ReadActionPayloadRunSnapshotsInput
    ): readonly ActionPayloadRunSnapshot[] {
        const actionKey = v.parse(jobActionKeySchema, input.actionKey);
        assertLimit(
            input.payloadJsons.length,
            actionPayloadRunSnapshotMaximum,
            "action payload run snapshot"
        );
        const usesMaintenanceStatusIndex = actionKey === logMaintenanceJobActionKey;
        const payloadJsons = input.payloadJsons.map((payloadJson) => {
            if (utf8ByteLength(payloadJson) > jobPayloadMaximumBytes) {
                throw new TypeError(
                    "Jobs repository action payload is outside its budget"
                );
            }
            const canonical = JSON.stringify(
                v.parse(jobPayloadSchema, parseJsonText(payloadJson))
            );
            if (
                usesMaintenanceStatusIndex &&
                utf8ByteLength(canonical) > logMaintenanceJobPayloadIndexMaximumBytes
            ) {
                throw new TypeError(
                    "Jobs repository log-maintenance payload is outside its status budget"
                );
            }
            return canonical;
        });
        if (new Set(payloadJsons).size !== payloadJsons.length) {
            throw new TypeError(
                "Jobs repository action payload run snapshots must be unique"
            );
        }
        return payloadJsons.map((payloadJson) => {
            const actionCondition = eq(jobRuns.actionKey, actionKey);
            const activeRow = this.database
                .select()
                .from(jobRuns)
                .where(
                    and(
                        actionCondition,
                        eq(jobRuns.payloadJson, payloadJson),
                        activeStateFilter
                    )
                )
                .orderBy(desc(jobRuns.state), desc(jobRuns.queuedAt), desc(jobRuns.id))
                .get();
            const lastRow = this.database
                .select()
                .from(jobRuns)
                .where(
                    and(
                        usesMaintenanceStatusIndex
                            ? logMaintenanceSnapshotScopeFilter
                            : actionCondition,
                        eq(jobRuns.payloadJson, payloadJson),
                        terminalStateFilter
                    )
                )
                .orderBy(desc(jobRuns.queuedAt), desc(jobRuns.id))
                .get();
            return {
                ...(activeRow === undefined ? {} : { activeRun: parseRun(activeRow) }),
                ...(lastRow === undefined ? {} : { lastRun: parseRun(lastRow) }),
                payloadJson,
            };
        });
    }

    public findRunDetail(input: ListJobRunEventsInput): JobRunDetailRecord | undefined {
        const run = this.findRun(input.runId);
        return run === undefined ? undefined : { events: this.listRunEvents(input), run };
    }

    public findSchedule(id: string): ScheduleRecordWithRelations | undefined {
        const row = this.database
            .select()
            .from(scheduledJobs)
            .where(eq(scheduledJobs.id, id))
            .get();
        if (row === undefined) return undefined;
        return this.#attachScheduleRelations([parseSchedule(row)])[0];
    }

    public listDueSchedules(input: ListDueSchedulesInput): ScheduledJobRecord[] {
        const limit = input.limit ?? claimCandidateMaximum;
        assertLimit(limit, claimCandidateMaximum, "due schedule");
        return this.database
            .select()
            .from(scheduledJobs)
            .where(
                and(
                    eq(scheduledJobs.enabled, true),
                    isNotNull(scheduledJobs.nextRunAt),
                    lte(scheduledJobs.nextRunAt, input.at),
                    input.cursor === undefined
                        ? undefined
                        : sql`(${scheduledJobs.nextRunAt}, ${scheduledJobs.id}) >
                              (${getTime(input.cursor.nextRunAt)}, ${input.cursor.id})`
                )
            )
            .orderBy(asc(scheduledJobs.nextRunAt), asc(scheduledJobs.id))
            .limit(limit)
            .all()
            .map((row) => parseSchedule(row));
    }

    public listRunEvents(input: ListJobRunEventsInput): JobRunEventRecord[] {
        assertLimit(input.limit, jobRunEventPageMaximum, "run event page");
        return this.database
            .select()
            .from(jobRunEvents)
            .where(
                and(
                    eq(jobRunEvents.jobRunId, input.runId),
                    input.beforeSequence === undefined
                        ? undefined
                        : lt(jobRunEvents.sequence, input.beforeSequence)
                )
            )
            .orderBy(desc(jobRunEvents.sequence))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseEvent(row));
    }

    public listRuns(input: ListJobRunsInput): JobRunRecord[] {
        assertLimit(input.limit, jobRunPageMaximum, "run page");
        return this.database
            .select()
            .from(jobRuns)
            .where(and(runCursorBoundary(input), ...runFilterConditions(input)))
            .orderBy(desc(jobRuns.queuedAt), desc(jobRuns.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseRun(row));
    }

    public listRunsWithQueueState(
        input: ListJobRunsWithQueueStateInput
    ): JobRunPageSnapshot {
        return Object.freeze({
            queue: this.readQueueState(input),
            runs: this.listRuns(input),
        });
    }

    public listScheduleRuns(input: ListScheduleRunsInput): JobRunRecord[] {
        assertLimit(input.limit, jobRunPageMaximum, "schedule run page");
        return this.database
            .select()
            .from(jobRuns)
            .where(and(eq(jobRuns.scheduledJobId, input.id), runCursorBoundary(input)))
            .orderBy(desc(jobRuns.queuedAt), desc(jobRuns.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseRun(row));
    }

    public listSchedules(input: ListSchedulesInput): ScheduleRecordWithRelations[] {
        assertLimit(input.limit, schedulePageMaximum, "schedule page");
        const records = this.database
            .select()
            .from(scheduledJobs)
            .where(
                and(
                    input.cursor === undefined
                        ? undefined
                        : gt(scheduledJobs.id, input.cursor.id),
                    input.enabled === "all"
                        ? undefined
                        : eq(scheduledJobs.enabled, input.enabled === "enabled")
                )
            )
            .orderBy(asc(scheduledJobs.id))
            .limit(input.limit + 1)
            .all()
            .map((row) => parseSchedule(row));
        return this.#attachScheduleRelations(records);
    }

    public readClaimCancellation(input: ClaimFenceInput): JobClaimCancellation {
        const row = this.database
            .select({ cancelRequestedAt: jobRuns.cancelRequestedAt })
            .from(jobRuns)
            .where(
                and(
                    eq(jobRuns.id, input.runId),
                    eq(jobRuns.state, "running"),
                    eq(jobRuns.leaseOwnerId, input.workerId),
                    eq(jobRuns.leaseToken, input.leaseToken),
                    gt(jobRuns.leaseExpiresAt, input.at)
                )
            )
            .get();
        return row === undefined
            ? { cancelRequested: false, valid: false }
            : { cancelRequested: row.cancelRequestedAt !== null, valid: true };
    }

    public readQueueState(input: ReadQueueStateInput): JobQueueState {
        const countRows = this.database
            .select({ state: jobRuns.state, value: count() })
            .from(jobRuns)
            .groupBy(jobRuns.state)
            .all();
        const stateCounts = Object.fromEntries(
            jobRunStates.map((state) => [state, 0])
        ) as Record<JobRunState, number>;
        for (const row of countRows) stateCounts[row.state] = row.value;

        const oldestQueued = this.database
            .select({ queuedAt: jobRuns.queuedAt })
            .from(jobRuns)
            .where(eq(jobRuns.state, "queued"))
            .orderBy(asc(jobRuns.queuedAt), asc(jobRuns.id))
            .get();
        const activeClassRows = this.database
            .selectDistinct({ resourceClass: jobRuns.resourceClass })
            .from(jobRuns)
            .where(eq(jobRuns.state, "running"))
            .all();
        const activeClassSet = new Set(
            activeClassRows.map(({ resourceClass }) => resourceClass)
        );
        const activeResourceClasses = jobResourceClasses.filter((resourceClass) =>
            activeClassSet.has(resourceClass)
        );

        const workerRows = this.database
            .select()
            .from(workerInstances)
            .where(
                and(
                    inArray(workerInstances.state, ["draining", "online"]),
                    gte(workerInstances.heartbeatAt, input.minimumHeartbeatAt)
                )
            )
            .orderBy(asc(workerInstances.id))
            .limit(jobWorkerSummaryMaximum)
            .all()
            .map((row) => parseWorker(row));
        const workerIds = workerRows.map(({ id }) => id);
        const activeCounts =
            workerIds.length === 0
                ? []
                : this.database
                      .select({ ownerId: jobRuns.leaseOwnerId, value: count() })
                      .from(jobRuns)
                      .where(
                          and(
                              eq(jobRuns.state, "running"),
                              inArray(jobRuns.leaseOwnerId, workerIds)
                          )
                      )
                      .groupBy(jobRuns.leaseOwnerId)
                      .all();
        const activeCountByWorker = new Map(
            activeCounts.flatMap((row) =>
                row.ownerId === null ? [] : [[row.ownerId, row.value] as const]
            )
        );
        return {
            activeResourceClasses,
            control: this.readWorkerControl(),
            ...(oldestQueued === undefined
                ? {}
                : { oldestQueuedAt: oldestQueued.queuedAt }),
            stateCounts,
            workers: workerRows.map((worker) => ({
                activeRunCount: activeCountByWorker.get(worker.id) ?? 0,
                worker,
            })),
        };
    }

    public readHealthState(input: ReadJobHealthStateInput): JobHealthState {
        const queued = this.database
            .select({ oldestQueuedAt: min(jobRuns.queuedAt), value: count() })
            .from(jobRuns)
            .where(eq(jobRuns.state, "queued"))
            .get();
        const runningRunCount =
            this.database
                .select({ value: count() })
                .from(jobRuns)
                .where(eq(jobRuns.state, "running"))
                .get()?.value ?? 0;
        const exactReleaseOnlineCount =
            input.expectedReleaseId === undefined
                ? sql<number>`0`
                : sql<number>`coalesce(sum(case when ${workerInstances.state} = 'online' and ${workerInstances.releaseId} = ${input.expectedReleaseId} then 1 else 0 end), 0)`;
        const workers = this.database
            .select({
                capacity: sql<number>`coalesce(sum(${workerInstances.capacity}), 0)`,
                drainingCount: sql<number>`coalesce(sum(case when ${workerInstances.state} = 'draining' then 1 else 0 end), 0)`,
                exactReleaseOnlineCount,
                freshCount: count(),
                onlineCount: sql<number>`coalesce(sum(case when ${workerInstances.state} = 'online' then 1 else 0 end), 0)`,
            })
            .from(workerInstances)
            .where(
                and(
                    inArray(workerInstances.state, ["draining", "online"]),
                    gte(workerInstances.heartbeatAt, input.minimumHeartbeatAt)
                )
            )
            .get();
        return {
            control: this.readWorkerControl(),
            ...(queued?.oldestQueuedAt === null || queued?.oldestQueuedAt === undefined
                ? {}
                : { oldestQueuedAt: queued.oldestQueuedAt }),
            queuedRunCount: queued?.value ?? 0,
            runningRunCount,
            workers: {
                capacity: workers?.capacity ?? 0,
                drainingCount: workers?.drainingCount ?? 0,
                exactReleaseOnline: (workers?.exactReleaseOnlineCount ?? 0) > 0,
                freshCount: workers?.freshCount ?? 0,
                onlineCount: workers?.onlineCount ?? 0,
            },
        };
    }

    public readWorkerActionAvailability(
        input: ReadWorkerActionAvailabilityInput
    ): readonly string[] {
        const actionKeys = canonicalWorkerActionKeys(input.actionKeys);
        if (actionKeys.length === 0) return Object.freeze([]);
        const expectedReleaseId = v.parse(
            fullCommitShaSchema("Expected worker release id is invalid"),
            input.expectedReleaseId
        );
        const minimumHeartbeatAtMs = v.parse(
            jobTimestampSchema,
            getTime(input.minimumHeartbeatAt)
        );
        const rows = this.database.all<unknown>(sql`
            SELECT DISTINCT CAST(action.value AS TEXT) AS actionKey
            FROM ${workerInstances} AS worker
            JOIN json_each(worker.action_keys_json) AS action
            WHERE worker.state = 'online'
              AND worker.release_id = ${expectedReleaseId}
              AND worker.heartbeat_at >= ${minimumHeartbeatAtMs}
              AND CAST(action.value AS TEXT) IN (${sql.join(
                  actionKeys.map((actionKey) => sql`${actionKey}`),
                  sql`, `
              )})
            ORDER BY actionKey ASC
            LIMIT ${actionKeys.length}
        `);
        const parsed = v
            .parse(
                v.array(
                    v.strictObject({
                        actionKey: v.string("Worker action key is invalid"),
                    }),
                    "Worker action availability is invalid"
                ),
                rows
            )
            .map(({ actionKey }) => actionKey);
        return Object.freeze([...v.parse(workerActionKeysSchema, parsed)]);
    }

    public readWorkerControl(): JobWorkerControlRecord {
        const row = this.database
            .select()
            .from(jobWorkerControl)
            .where(eq(jobWorkerControl.id, 1))
            .get();
        return v.parse(
            jobWorkerControlSelectSchema,
            requiredRow(row, "worker control read")
        );
    }

    #attachScheduleRelations(
        records: readonly ScheduledJobRecord[]
    ): ScheduleRecordWithRelations[] {
        if (records.length === 0) return [];
        const ids = records.map(({ id }) => id);
        const activeIntents = this.database
            .select()
            .from(jobDisableIntents)
            .where(
                and(
                    inArray(jobDisableIntents.scheduledJobId, ids),
                    isNull(jobDisableIntents.endedAt)
                )
            )
            .all()
            .map((row) => parseDisableIntent(row));
        const activeRuns = this.database
            .select()
            .from(jobRuns)
            .where(
                and(
                    inArray(jobRuns.scheduledJobId, ids),
                    inArray(jobRuns.state, ["queued", "running"])
                )
            )
            .all()
            .map((row) => parseRun(row));
        const latestIds = this.database.all<{ id: string }>(sql`
            SELECT ranked.id
            FROM (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY scheduled_job_id
                           ORDER BY queued_at DESC, id DESC
                       ) AS position
                FROM job_runs
                WHERE scheduled_job_id IN (${sql.join(
                    ids.map((id) => sql`${id}`),
                    sql`, `
                )})
            ) AS ranked
            WHERE ranked.position = 1
        `);
        const latestRuns =
            latestIds.length === 0
                ? []
                : this.database
                      .select()
                      .from(jobRuns)
                      .where(
                          inArray(
                              jobRuns.id,
                              latestIds.map(({ id }) => id)
                          )
                      )
                      .all()
                      .map((row) => parseRun(row));
        const intentBySchedule = new Map(
            activeIntents.flatMap((intent) =>
                intent.scheduledJobId === null
                    ? []
                    : [[intent.scheduledJobId, intent] as const]
            )
        );
        const activeRunBySchedule = new Map(
            activeRuns.flatMap((run) =>
                run.scheduledJobId === null ? [] : [[run.scheduledJobId, run] as const]
            )
        );
        const latestRunBySchedule = new Map(
            latestRuns.flatMap((run) =>
                run.scheduledJobId === null ? [] : [[run.scheduledJobId, run] as const]
            )
        );
        return records.map((schedule) => ({
            ...(intentBySchedule.has(schedule.id)
                ? { activeDisableIntent: intentBySchedule.get(schedule.id) }
                : {}),
            ...(activeRunBySchedule.has(schedule.id)
                ? { activeRun: activeRunBySchedule.get(schedule.id) }
                : {}),
            ...(latestRunBySchedule.has(schedule.id)
                ? { latestRun: latestRunBySchedule.get(schedule.id) }
                : {}),
            schedule,
        }));
    }
}

class DrizzleJobWriter extends DrizzleJobReader {
    readonly #transaction: JobTransaction;

    public constructor(transaction: JobTransaction) {
        super(transaction);
        this.#transaction = transaction;
    }

    public reconcileSchedules(input: ReconcileSchedulesInput): ScheduledJobRecord[] {
        const records: ScheduledJobRecord[] = [];
        const registeredScheduleIds = new Set(
            input.schedules.map((schedule) => schedule.id)
        );
        for (const candidate of input.schedules) {
            const validated = v.parse(scheduledJobInsertSchema, candidate);
            const existing = this.#findScheduleRecord(validated.id);
            if (existing === undefined) {
                const inserted = this.#transaction
                    .insert(scheduledJobs)
                    .values(validated)
                    .returning()
                    .get();
                const registered = parseSchedule(
                    requiredRow(inserted, "schedule insert")
                );
                records.push(registered);
                this.#insertSideEffects(input.sideEffectsForSchedule(registered));
                continue;
            }
            const metadataChanged =
                existing.actionKey !== validated.actionKey ||
                existing.actionPayloadJson !== validated.actionPayloadJson ||
                existing.attemptLimit !== validated.attemptLimit ||
                existing.cancellationPolicy !== validated.cancellationPolicy ||
                existing.description !== validated.description ||
                existing.name !== validated.name ||
                existing.priority !== validated.priority ||
                existing.resourceClass !== validated.resourceClass ||
                existing.resourceKeysJson !== validated.resourceKeysJson ||
                existing.retrySafe !== validated.retrySafe ||
                existing.timeoutMs !== validated.timeoutMs;
            if (!metadataChanged) {
                records.push(existing);
                continue;
            }
            const row = this.#transaction
                .update(scheduledJobs)
                .set({
                    actionKey: validated.actionKey,
                    actionPayloadJson: validated.actionPayloadJson,
                    attemptLimit: validated.attemptLimit,
                    cancellationPolicy: validated.cancellationPolicy,
                    description: validated.description,
                    name: validated.name,
                    priority: validated.priority,
                    resourceClass: validated.resourceClass,
                    resourceKeysJson: validated.resourceKeysJson,
                    retrySafe: validated.retrySafe,
                    timeoutMs: validated.timeoutMs,
                    updatedAt: maximumDate(existing.updatedAt, validated.updatedAt),
                    version: existing.version + 1,
                })
                .where(
                    and(
                        eq(scheduledJobs.id, existing.id),
                        eq(scheduledJobs.version, existing.version)
                    )
                )
                .returning()
                .get();
            const reconciled = parseSchedule(requiredRow(row, "schedule reconciliation"));
            records.push(reconciled);
            this.#insertSideEffects(input.sideEffectsForSchedule(reconciled));
        }
        const retiredSchedules = this.#transaction
            .select()
            .from(scheduledJobs)
            .where(eq(scheduledJobs.enabled, true))
            .all()
            .map((row) => parseSchedule(row))
            .filter((schedule) => !registeredScheduleIds.has(schedule.id));
        for (const schedule of retiredSchedules) {
            const queuedScheduleRun = this.#findQueuedScheduleRun(schedule.id);
            // Registry retirement disables future scheduling. A queued `never` run keeps
            // its immutable execution snapshot and completes through the normal worker
            // action-availability path; retirement must not reinterpret it as cancellable.
            const cancellableQueuedScheduleRun =
                queuedScheduleRun?.cancellationPolicy === "never"
                    ? undefined
                    : queuedScheduleRun;
            const retiredRunCancellation = input.retiredRunCancellation;
            if (
                cancellableQueuedScheduleRun !== undefined &&
                retiredRunCancellation === undefined
            ) {
                throw new Error(
                    "Removed schedule retirement requires queued-run cancellation metadata"
                );
            }
            const retired = this.#transaction
                .update(scheduledJobs)
                .set({
                    enabled: false,
                    updatedAt: maximumDate(schedule.updatedAt, input.at),
                    version: schedule.version + 1,
                })
                .where(
                    and(
                        eq(scheduledJobs.id, schedule.id),
                        eq(scheduledJobs.enabled, true),
                        eq(scheduledJobs.version, schedule.version)
                    )
                )
                .returning()
                .get();
            const retiredSchedule = parseSchedule(
                requiredRow(retired, "removed schedule retirement")
            );
            if (
                cancellableQueuedScheduleRun !== undefined &&
                retiredRunCancellation !== undefined
            ) {
                const cancelled = this.#cancelQueuedRun(
                    cancellableQueuedScheduleRun,
                    retiredRunCancellation.actor,
                    {
                        at: retiredSchedule.updatedAt,
                        terminalCode: retiredRunCancellation.terminalCode,
                        terminalMessage: retiredRunCancellation.terminalMessage,
                    }
                );
                this.#insertSideEffects(
                    retiredRunCancellation.sideEffectsForRun(cancelled)
                );
            }
            this.#insertSideEffects(input.sideEffectsForSchedule(retiredSchedule));
        }
        return records;
    }

    public enqueueManualRun(input: EnqueueManualRunInput): EnqueueManualRunResult {
        const run = v.parse(jobRunInsertSchema, input.run);
        if (input.queuedEvent.jobRunId !== run.id) {
            throw new Error("Queued event does not belong to the inserted manual run");
        }
        const existing = this.findRunByIdempotency(
            run.requestedByKind,
            run.requestedById,
            run.idempotencyKey
        );
        if (existing !== undefined) {
            return existing.enqueueSha256 === run.enqueueSha256
                ? { kind: "replayed", run: existing }
                : { kind: "idempotency-mismatch", run: existing };
        }
        if (run.scheduledJobId !== null) {
            const schedule = this.#findScheduleRecord(run.scheduledJobId);
            if (
                schedule === undefined ||
                !runMatchesScheduleExecutionSnapshot(run, schedule)
            ) {
                return { kind: "action-unavailable" };
            }
            const active = this.findActiveRunForSchedule(run.scheduledJobId);
            if (active !== undefined) return { kind: "active", run: active };
        }
        if (input.rejectWhenActionActive === true) {
            const active = this.#transaction
                .select()
                .from(jobRuns)
                .where(and(eq(jobRuns.actionKey, run.actionKey), activeStateFilter))
                .get();
            if (active !== undefined) return { kind: "active", run: parseRun(active) };
        }
        const inserted = this.#transaction.insert(jobRuns).values(run).returning().get();
        const record = parseRun(requiredRow(inserted, "manual run insert"));
        this.#insertSuppliedEvent(input.queuedEvent);
        this.#insertSideEffects(input);
        return {
            kind: "inserted",
            run: requiredRow(this.findRun(record.id), "manual run refresh"),
        };
    }

    public updateSchedule(
        input: UpdateScheduleRepositoryInput
    ): UpdateScheduleRepositoryResult {
        const current = this.#findScheduleRecord(input.id);
        if (current === undefined) return { kind: "not-found" };
        if (current.version !== input.expectedVersion) {
            return { kind: "version-changed", schedule: current };
        }
        const activeIntent = this.findActiveDisableIntent(input.id);
        if ((activeIntent?.id ?? null) !== input.expectedActiveDisableIntentId) {
            return { kind: "version-changed", schedule: current };
        }
        const queuedScheduleRunRecord =
            input.patch.enabled === false
                ? this.#findQueuedScheduleRun(input.id)
                : undefined;
        if (queuedScheduleRunRecord?.cancellationPolicy === "never") {
            return {
                kind: "cancellation-not-supported",
                run: queuedScheduleRunRecord,
            };
        }
        const transitionAt = maximumDate(current.updatedAt, input.at);
        const scheduleChanges =
            input.patch.schedule === undefined
                ? {}
                : this.#scheduleColumns(input.patch.schedule);
        const enabled = input.patch.enabled ?? current.enabled;
        let nextRunAt = current.nextRunAt;
        // A pure disable keeps the existing cursor dormant. When the cadence also
        // changes, retain the service's recalculated cursor for the new phase.
        if (
            input.patch.nextRunAt !== undefined &&
            (input.patch.enabled !== false || input.patch.schedule !== undefined)
        ) {
            nextRunAt = input.patch.nextRunAt;
        }
        if (enabled && nextRunAt === null) {
            throw new TypeError("Enabled schedule requires one next occurrence");
        }

        if (input.closeActiveIntent !== undefined) {
            if (activeIntent === undefined) {
                throw new Error("Schedule disable-intent closure has no active intent");
            }
            const closed = this.#transaction
                .update(jobDisableIntents)
                .set(v.parse(jobDisableIntentCloseSchema, input.closeActiveIntent))
                .where(
                    and(
                        eq(jobDisableIntents.id, activeIntent.id),
                        isNull(jobDisableIntents.endedAt)
                    )
                )
                .returning()
                .get();
            requiredRow(closed, "disable intent closure");
        }
        if (input.insertDisableIntent !== undefined) {
            this.#transaction
                .insert(jobDisableIntents)
                .values(v.parse(jobDisableIntentInsertSchema, input.insertDisableIntent))
                .run();
        }

        const row = this.#transaction
            .update(scheduledJobs)
            .set({
                ...scheduleChanges,
                enabled,
                nextRunAt,
                updatedAt: transitionAt,
                version: current.version + 1,
            })
            .where(
                and(
                    eq(scheduledJobs.id, input.id),
                    eq(scheduledJobs.version, input.expectedVersion)
                )
            )
            .returning()
            .get();
        if (row === undefined) {
            throw new Error(
                "Schedule update lost its guarded write after intent changes"
            );
        }

        if (input.patch.enabled === false && queuedScheduleRunRecord !== undefined) {
            if (
                input.queuedCancellation === undefined ||
                input.queuedCancellationSideEffects === undefined ||
                input.insertDisableIntent === undefined
            ) {
                throw new Error(
                    "Schedule disable requires queued-run cancellation metadata"
                );
            }
            const actor: JobActor = {
                id: input.insertDisableIntent.createdById,
                kind: input.insertDisableIntent.createdByKind,
            };
            const cancelled = this.#cancelQueuedRun(
                queuedScheduleRunRecord,
                actor,
                input.queuedCancellation
            );
            this.#insertSideEffects(input.queuedCancellationSideEffects(cancelled));
        }
        this.#insertSideEffects(input);
        return { kind: "updated", schedule: parseSchedule(row) };
    }

    public enqueueNextDueSchedule(
        input: DueScheduleEnqueueInput
    ): DueScheduleEnqueueResult {
        const validatedRun = v.parse(jobRunInsertSchema, input.run);
        const replay = this.findRunByIdempotency(
            validatedRun.requestedByKind,
            validatedRun.requestedById,
            validatedRun.idempotencyKey
        );
        if (replay !== undefined && replay.enqueueSha256 === validatedRun.enqueueSha256) {
            return { kind: "inserted", run: replay };
        }
        const schedule = this.#findScheduleRecord(input.scheduleId);
        if (schedule === undefined) return { kind: "not-found" };
        if (!runMatchesScheduleExecutionSnapshot(validatedRun, schedule)) {
            return { kind: "state-changed", schedule };
        }
        if (
            !schedule.enabled ||
            schedule.nextRunAt === null ||
            getTime(schedule.nextRunAt) !== getTime(input.observedNextRunAt)
        ) {
            return { kind: "state-changed", schedule };
        }
        if (getTime(schedule.nextRunAt) > getTime(input.at)) {
            return { kind: "not-due" };
        }
        const active = this.findActiveRunForSchedule(schedule.id);
        if (active !== undefined) return { kind: "active", run: active };
        if (input.rejectWhenActionActive === true) {
            const activeActionRun = this.#transaction
                .select()
                .from(jobRuns)
                .where(
                    and(eq(jobRuns.actionKey, validatedRun.actionKey), activeStateFilter)
                )
                .get();
            if (activeActionRun !== undefined) {
                return { kind: "active", run: parseRun(activeActionRun) };
            }
        }
        if (
            validatedRun.triggerType !== "schedule" ||
            validatedRun.scheduledJobId !== schedule.id ||
            validatedRun.scheduledForAt === null ||
            getTime(validatedRun.scheduledForAt) !== getTime(schedule.nextRunAt) ||
            getTime(input.nextRunAt) <= getTime(input.at)
        ) {
            throw new TypeError("Due schedule enqueue snapshot is inconsistent");
        }
        const inserted = this.#transaction
            .insert(jobRuns)
            .values(validatedRun)
            .returning()
            .get();
        const run = parseRun(requiredRow(inserted, "due run insert"));
        this.#appendEvent(run.id, {
            attempt: 0,
            kind: "queued",
            occurredAt: run.queuedAt,
            workerInstanceId: null,
        });
        const advanced = this.#transaction
            .update(scheduledJobs)
            .set({ nextRunAt: input.nextRunAt })
            .where(
                and(
                    eq(scheduledJobs.id, schedule.id),
                    eq(scheduledJobs.enabled, true),
                    eq(scheduledJobs.version, schedule.version),
                    eq(scheduledJobs.nextRunAt, input.observedNextRunAt)
                )
            )
            .returning()
            .get();
        requiredRow(advanced, "due schedule cursor advance");
        this.#insertSideEffects(input);
        return {
            kind: "inserted",
            run: requiredRow(this.findRun(run.id), "due run refresh"),
        };
    }

    public cancelRun(input: CancelRunRepositoryInput): CancelRunRepositoryResult {
        const run = this.findRun(input.id);
        if (run === undefined) return { kind: "not-found" };
        if (terminalRunStates.has(run.state)) return { kind: "terminal", run };
        const supportsCancellation =
            run.cancellationPolicy === "cooperative" ||
            (run.cancellationPolicy === "queued-only" && run.state === "queued");
        if (!supportsCancellation) return { kind: "unsupported", run };
        if (run.cancelRequestedAt !== null) {
            return run.state === "queued"
                ? { kind: "cancelled", run }
                : { kind: "requested", run };
        }
        if (run.state === "queued") {
            const cancelled = this.#cancelQueuedRun(run, input.actor, input);
            this.#insertSideEffects(input.sideEffectsForRun(cancelled));
            return { kind: "cancelled", run: cancelled };
        }
        const at = maximumDate(run.updatedAt, input.at);
        const row = this.#transaction
            .update(jobRuns)
            .set({
                cancelRequestedAt: at,
                cancelRequestedById: input.actor.id,
                cancelRequestedByKind: input.actor.kind,
                stateVersion: run.stateVersion + 1,
                updatedAt: at,
            })
            .where(
                and(
                    eq(jobRuns.id, run.id),
                    eq(jobRuns.state, "running"),
                    isNull(jobRuns.cancelRequestedAt),
                    eq(jobRuns.stateVersion, run.stateVersion)
                )
            )
            .returning()
            .get();
        if (row === undefined) {
            const observed = requiredRow(this.findRun(run.id), "cancel conflict read");
            return terminalRunStates.has(observed.state)
                ? { kind: "terminal", run: observed }
                : { kind: "requested", run: observed };
        }
        this.#appendEvent(run.id, {
            attempt: run.attemptCount,
            kind: "cancel-requested",
            occurredAt: at,
            workerInstanceId: run.leaseOwnerId,
        });
        const requested = requiredRow(this.findRun(run.id), "cancel request refresh");
        this.#insertSideEffects(input.sideEffectsForRun(requested));
        return {
            kind: "requested",
            run: requested,
        };
    }

    public setClaimingPaused(
        input: SetClaimingPausedRepositoryInput
    ): SetClaimingPausedRepositoryResult {
        const current = v.parse(
            jobWorkerControlSelectSchema,
            requiredRow(
                this.#transaction
                    .select()
                    .from(jobWorkerControl)
                    .where(eq(jobWorkerControl.id, 1))
                    .get(),
                "worker control read"
            )
        );
        if (current.version !== input.expectedVersion) {
            return { control: current, kind: "version-changed" };
        }
        const update = v.parse(jobWorkerControlUpdateSchema, {
            claimingPaused: input.paused,
            updatedAt: maximumDate(current.updatedAt, input.at),
            updatedById: input.actor.id,
            updatedByKind: input.actor.kind,
            version: current.version + 1,
        });
        const row = this.#transaction
            .update(jobWorkerControl)
            .set(update)
            .where(
                and(
                    eq(jobWorkerControl.id, 1),
                    eq(jobWorkerControl.version, input.expectedVersion)
                )
            )
            .returning()
            .get();
        if (row === undefined) {
            const observed = v.parse(
                jobWorkerControlSelectSchema,
                requiredRow(
                    this.#transaction
                        .select()
                        .from(jobWorkerControl)
                        .where(eq(jobWorkerControl.id, 1))
                        .get(),
                    "worker control conflict read"
                )
            );
            return { control: observed, kind: "version-changed" };
        }
        const control = v.parse(jobWorkerControlSelectSchema, row);
        this.#insertSideEffects(input);
        return { control, kind: "updated" };
    }

    public registerWorker(input: RegisterWorkerInput): WorkerInstanceRecord {
        const row = this.#transaction
            .insert(workerInstances)
            .values(v.parse(workerInstanceInsertSchema, input.worker))
            .returning()
            .get();
        const worker = parseWorker(requiredRow(row, "worker registration"));
        this.#insertSideEffects(input);
        return worker;
    }

    public heartbeatWorker(
        input: WorkerLifecycleInput
    ): WorkerInstanceRecord | undefined {
        const worker = this.#findWorker(input.workerId);
        if (worker === undefined || worker.state === "stopped") return worker;
        const at = maximumDate(worker.heartbeatAt, input.at);
        if (getTime(at) === getTime(worker.heartbeatAt)) return worker;
        const row = this.#transaction
            .update(workerInstances)
            .set({ heartbeatAt: at })
            .where(
                and(
                    eq(workerInstances.id, worker.id),
                    eq(workerInstances.state, worker.state),
                    lte(workerInstances.heartbeatAt, at)
                )
            )
            .returning()
            .get();
        return row === undefined ? this.#findWorker(worker.id) : parseWorker(row);
    }

    public beginWorkerDrain(input: WorkerLifecycleMutationInput): WorkerLifecycleResult {
        const worker = this.#findWorker(input.workerId);
        if (worker === undefined) return { kind: "not-found" };
        if (worker.state !== "online") {
            return { kind: "state-changed", worker };
        }
        const at = maximumDate(worker.heartbeatAt, worker.startedAt, input.at);
        const row = this.#transaction
            .update(workerInstances)
            .set({ drainingAt: at, heartbeatAt: at, state: "draining" })
            .where(
                and(
                    eq(workerInstances.id, worker.id),
                    eq(workerInstances.state, "online")
                )
            )
            .returning()
            .get();
        if (row === undefined) {
            return {
                kind: "state-changed",
                worker: requiredRow(this.#findWorker(worker.id), "worker drain read"),
            };
        }
        const updated = parseWorker(row);
        this.#insertSideEffects(input.sideEffectsForWorker(updated));
        return { kind: "updated", worker: updated };
    }

    public stopWorker(input: WorkerLifecycleMutationInput): WorkerLifecycleResult {
        const worker = this.#findWorker(input.workerId);
        if (worker === undefined) return { kind: "not-found" };
        if (worker.state !== "draining") {
            return { kind: "state-changed", worker };
        }
        const activeRun = this.#transaction
            .select({ id: jobRuns.id })
            .from(jobRuns)
            .where(and(eq(jobRuns.state, "running"), eq(jobRuns.leaseOwnerId, worker.id)))
            .limit(1)
            .get();
        if (activeRun !== undefined) return { kind: "active-runs", worker };
        const at = maximumDate(
            worker.heartbeatAt,
            requiredValue(worker.drainingAt, "worker draining timestamp"),
            input.at
        );
        const row = this.#transaction
            .update(workerInstances)
            .set({ heartbeatAt: at, state: "stopped", stoppedAt: at })
            .where(
                and(
                    eq(workerInstances.id, worker.id),
                    eq(workerInstances.state, "draining")
                )
            )
            .returning()
            .get();
        if (row === undefined) {
            return {
                kind: "state-changed",
                worker: requiredRow(this.#findWorker(worker.id), "worker stop read"),
            };
        }
        const updated = parseWorker(row);
        this.#insertSideEffects(input.sideEffectsForWorker(updated));
        return { kind: "updated", worker: updated };
    }

    public expireDisableIntents(
        input: ExpireDisableIntentsInput
    ): readonly ExpireDisableIntentResult[] {
        const limit = input.limit ?? recoveryBatchMaximum;
        assertLimit(limit, recoveryBatchMaximum, "disable-intent expiry");
        const intents = this.#transaction
            .select()
            .from(jobDisableIntents)
            .where(
                and(
                    eq(jobDisableIntents.targetKind, "dashboard-schedule"),
                    isNull(jobDisableIntents.endedAt),
                    isNotNull(jobDisableIntents.expiresAt),
                    lte(jobDisableIntents.expiresAt, input.at)
                )
            )
            .orderBy(asc(jobDisableIntents.expiresAt), asc(jobDisableIntents.id))
            .limit(limit)
            .all()
            .map((row) => parseDisableIntent(row));

        return intents.map((intent) => {
            const scheduleId = requiredValue(
                intent.scheduledJobId,
                "expired intent schedule id"
            );
            const schedule = requiredRow(
                this.#findScheduleRecord(scheduleId),
                "expired intent schedule"
            );
            if (schedule.enabled) {
                throw new Error("Enabled schedule retains an active disable intent");
            }
            if (!input.canReenableSchedule(schedule)) {
                const transitionAt = maximumDate(
                    schedule.updatedAt,
                    requiredValue(intent.expiresAt, "disable intent expiry"),
                    input.at
                );
                const closedIntent = this.#closeExpiredIntent({
                    at: input.at,
                    context: "retired schedule intent closure",
                    intent,
                    systemActorId: input.systemActorId,
                    transitionAt,
                });
                this.#insertSideEffects(
                    input.sideEffectsForSchedule(schedule, closedIntent)
                );
                return {
                    intent: closedIntent,
                    kind: "left-disabled" as const,
                    schedule,
                };
            }
            const nextRunAt = input.nextRunAt(schedule, input.at);
            if (nextRunAt === undefined) {
                return {
                    intent,
                    kind: "next-occurrence-unavailable" as const,
                    schedule,
                };
            }
            if (getTime(nextRunAt) <= getTime(input.at)) {
                throw new RangeError(
                    "Expired disable intent must resume strictly after transaction time"
                );
            }
            const transitionAt = maximumDate(
                schedule.updatedAt,
                requiredValue(intent.expiresAt, "disable intent expiry"),
                input.at
            );
            const closedIntent = this.#closeExpiredIntent({
                at: input.at,
                context: "expired intent closure",
                intent,
                systemActorId: input.systemActorId,
                transitionAt,
            });
            const scheduleRow = this.#transaction
                .update(scheduledJobs)
                .set({
                    enabled: true,
                    nextRunAt,
                    updatedAt: transitionAt,
                    version: schedule.version + 1,
                })
                .where(
                    and(
                        eq(scheduledJobs.id, schedule.id),
                        eq(scheduledJobs.enabled, false),
                        eq(scheduledJobs.version, schedule.version)
                    )
                )
                .returning()
                .get();
            const resumed = parseSchedule(
                requiredRow(scheduleRow, "expired schedule resume")
            );
            this.#insertSideEffects(input.sideEffectsForSchedule(resumed, closedIntent));
            return {
                intent: closedIntent,
                kind: "re-enabled" as const,
                schedule: resumed,
            };
        });
    }

    public recoverExpiredClaims(
        input: RecoverExpiredClaimsInput
    ): readonly JobRunRecord[] {
        const limit = input.limit ?? recoveryBatchMaximum;
        assertLimit(limit, recoveryBatchMaximum, "expired claim recovery");
        const expired = this.#transaction
            .select()
            .from(jobRuns)
            .where(
                and(eq(jobRuns.state, "running"), lte(jobRuns.leaseExpiresAt, input.at))
            )
            .orderBy(asc(jobRuns.leaseExpiresAt), asc(jobRuns.id))
            .limit(limit)
            .all()
            .map((row) => parseRun(row));
        return expired.map((run) => {
            const at = maximumDate(run.updatedAt, input.at);
            const shouldCancel = run.cancelRequestedAt !== null;
            const shouldRetry =
                !shouldCancel && run.retrySafe && run.attemptCount < run.attemptLimit;
            this.#releaseResources(
                run,
                requiredValue(run.leaseOwnerId, "expired claim owner"),
                requiredValue(run.leaseToken, "expired claim token")
            );
            if (shouldRetry) {
                const retryAt = maximumDate(at, input.retryAt(run));
                this.#transitionClaim(run, {
                    availableAt: retryAt,
                    heartbeatAt: null,
                    leaseExpiresAt: null,
                    leaseOwnerId: null,
                    leaseToken: null,
                    state: "queued",
                    stateVersion: run.stateVersion + 1,
                    updatedAt: at,
                });
                this.#appendEvent(run.id, {
                    attempt: run.attemptCount,
                    kind: "lease-expired",
                    occurredAt: at,
                    workerInstanceId: run.leaseOwnerId,
                });
                this.#appendEvent(run.id, {
                    attempt: run.attemptCount,
                    kind: "retry-scheduled",
                    occurredAt: at,
                    workerInstanceId: run.leaseOwnerId,
                });
            } else {
                const state = shouldCancel ? "cancelled" : "failed";
                this.#transitionClaim(run, {
                    finishedAt: at,
                    heartbeatAt: null,
                    leaseExpiresAt: null,
                    leaseOwnerId: null,
                    leaseToken: null,
                    state,
                    stateVersion: run.stateVersion + 1,
                    terminalCode: shouldCancel
                        ? "job/cancel-requested"
                        : "worker/lease-expired",
                    terminalMessage: shouldCancel
                        ? "The run was cancelled after its worker lease expired."
                        : "The worker lease expired and this action is not retryable.",
                    updatedAt: at,
                });
                this.#appendEvent(run.id, {
                    attempt: run.attemptCount,
                    kind: "lease-expired",
                    occurredAt: at,
                    workerInstanceId: run.leaseOwnerId,
                });
                this.#appendEvent(run.id, {
                    attempt: run.attemptCount,
                    kind: state,
                    occurredAt: at,
                    workerInstanceId: run.leaseOwnerId,
                });
            }
            const refreshed = requiredRow(this.findRun(run.id), "expired claim refresh");
            this.#insertSideEffects(input.sideEffectsForRun(refreshed));
            return refreshed;
        });
    }

    public claimNextRun(input: ClaimNextRunInput): JobClaimResult {
        if (getTime(input.leaseExpiresAt) <= getTime(input.at)) {
            throw new RangeError("Claim lease expiry must be after claim time");
        }
        const control = v.parse(
            jobWorkerControlSelectSchema,
            requiredRow(
                this.#transaction
                    .select()
                    .from(jobWorkerControl)
                    .where(eq(jobWorkerControl.id, 1))
                    .get(),
                "worker control claim read"
            )
        );
        if (control.claimingPaused) return { kind: "paused" };
        const worker = this.#findWorker(input.workerId);
        if (
            worker === undefined ||
            worker.state !== "online" ||
            getTime(worker.heartbeatAt) < getTime(input.minimumHeartbeatAt)
        ) {
            return { kind: "worker-unavailable" };
        }
        const activeCount = requiredRow(
            this.#transaction
                .select({ value: count() })
                .from(jobRuns)
                .where(
                    and(eq(jobRuns.state, "running"), eq(jobRuns.leaseOwnerId, worker.id))
                )
                .get(),
            "worker active count"
        ).value;
        if (activeCount >= worker.capacity) return { kind: "worker-unavailable" };
        const workerActionKeys = parseWorkerActionKeysJson(worker.actionKeysJson);
        if (workerActionKeys.length === 0) return { kind: "empty" };

        const availableThrough = input.cursor?.availableThrough ?? input.at;
        const candidates: JobRunRecord[] = [];
        const appendCandidateRange = (range?: SQL): void => {
            const remaining = claimCandidateMaximum - candidates.length;
            if (remaining === 0) return;
            candidates.push(
                ...this.#transaction
                    .select()
                    .from(jobRuns)
                    .where(
                        and(
                            eq(jobRuns.state, "queued"),
                            lte(jobRuns.availableAt, availableThrough),
                            inArray(jobRuns.actionKey, workerActionKeys),
                            range
                        )
                    )
                    .orderBy(
                        asc(jobRuns.availableAt),
                        desc(jobRuns.priority),
                        asc(jobRuns.queuedAt),
                        asc(jobRuns.id)
                    )
                    .limit(remaining)
                    .all()
                    .map((row) => parseRun(row))
            );
        };
        if (input.cursor === undefined) {
            appendCandidateRange();
        } else {
            const cursor = input.cursor;
            appendCandidateRange(
                and(
                    eq(jobRuns.availableAt, cursor.availableAt),
                    eq(jobRuns.priority, cursor.priority),
                    eq(jobRuns.queuedAt, cursor.queuedAt),
                    gt(jobRuns.id, cursor.id)
                )
            );
            appendCandidateRange(
                and(
                    eq(jobRuns.availableAt, cursor.availableAt),
                    eq(jobRuns.priority, cursor.priority),
                    gt(jobRuns.queuedAt, cursor.queuedAt)
                )
            );
            appendCandidateRange(
                and(
                    eq(jobRuns.availableAt, cursor.availableAt),
                    lt(jobRuns.priority, cursor.priority)
                )
            );
            appendCandidateRange(gt(jobRuns.availableAt, cursor.availableAt));
        }
        for (const candidate of candidates) {
            const keys = resourceKeys(candidate);
            const resourceConflict =
                keys.length > 0 &&
                this.#transaction
                    .select({ key: resourceLeases.resourceKey })
                    .from(resourceLeases)
                    .where(inArray(resourceLeases.resourceKey, keys))
                    .limit(1)
                    .get() !== undefined;
            if (resourceConflict) continue;

            const at = maximumDate(candidate.updatedAt, availableThrough, input.at);
            const leaseExpiresAt = shiftDurationToStart(
                input.at,
                input.leaseExpiresAt,
                at
            );
            const row = this.#transaction
                .update(jobRuns)
                .set({
                    attemptCount: candidate.attemptCount + 1,
                    firstStartedAt: candidate.firstStartedAt ?? at,
                    heartbeatAt: at,
                    lastAttemptStartedAt: at,
                    leaseExpiresAt,
                    leaseOwnerId: worker.id,
                    leaseToken: input.leaseToken,
                    state: "running",
                    stateVersion: candidate.stateVersion + 1,
                    updatedAt: at,
                })
                .where(
                    and(
                        eq(jobRuns.id, candidate.id),
                        eq(jobRuns.state, "queued"),
                        eq(jobRuns.stateVersion, candidate.stateVersion),
                        lte(jobRuns.availableAt, availableThrough)
                    )
                )
                .returning()
                .get();
            if (row === undefined) continue;
            const claimed = parseRun(row);
            for (const resourceKey of keys) {
                this.#transaction
                    .insert(resourceLeases)
                    .values(
                        v.parse(resourceLeaseInsertSchema, {
                            acquiredAt: at,
                            expiresAt: leaseExpiresAt,
                            jobRunId: claimed.id,
                            leaseToken: input.leaseToken,
                            renewedAt: at,
                            resourceKey,
                            workerInstanceId: worker.id,
                        })
                    )
                    .run();
            }
            this.#appendEvent(claimed.id, {
                attempt: claimed.attemptCount,
                kind: "claimed",
                occurredAt: at,
                workerInstanceId: worker.id,
            });
            const refreshed = requiredRow(
                this.findRun(claimed.id),
                "claimed run refresh"
            );
            this.#insertSideEffects(input.sideEffectsForClaim(refreshed));
            return {
                kind: "claimed",
                run: refreshed,
            };
        }
        const lastCandidate = candidates.at(-1);
        if (candidates.length === claimCandidateMaximum && lastCandidate !== undefined) {
            return {
                cursor: {
                    availableAt: lastCandidate.availableAt,
                    availableThrough,
                    id: lastCandidate.id,
                    priority: lastCandidate.priority,
                    queuedAt: lastCandidate.queuedAt,
                },
                kind: "page-exhausted",
            };
        }
        return { kind: "empty" };
    }

    public renewClaim(input: RenewClaimInput): JobClaimMutationResult {
        const run = this.#findFencedRun(input);
        if (run === undefined) return { kind: "lost-claim" };
        if (run.leaseExpiresAt === null) throw new Error("Active claim has no lease");
        const at = maximumDate(
            run.updatedAt,
            requiredValue(run.heartbeatAt, "claim heartbeat"),
            input.at
        );
        const leaseExpiresAt = shiftDurationToStart(input.at, input.leaseExpiresAt, at);
        if (getTime(leaseExpiresAt) <= getTime(run.leaseExpiresAt)) {
            throw new RangeError("Renewed lease expiry must advance the active lease");
        }
        const row = this.#transaction
            .update(jobRuns)
            .set({
                heartbeatAt: at,
                leaseExpiresAt,
                updatedAt: at,
            })
            .where(this.#claimFence(input))
            .returning()
            .get();
        if (row === undefined) return { kind: "lost-claim" };
        const expectedKeys = resourceKeys(parseRun(row));
        const renewed =
            expectedKeys.length === 0
                ? []
                : this.#transaction
                      .update(resourceLeases)
                      .set({ expiresAt: leaseExpiresAt, renewedAt: at })
                      .where(
                          and(
                              eq(resourceLeases.jobRunId, input.runId),
                              eq(resourceLeases.workerInstanceId, input.workerId),
                              eq(resourceLeases.leaseToken, input.leaseToken),
                              inArray(resourceLeases.resourceKey, expectedKeys)
                          )
                      )
                      .returning()
                      .all()
                      .map((lease) => v.parse(resourceLeaseSelectSchema, lease));
        if (renewed.length !== expectedKeys.length) {
            throw new Error("Claim resource lease set is incomplete during renewal");
        }
        return {
            kind: "renewed",
            run: requiredRow(this.findRun(input.runId), "renewed claim refresh"),
        };
    }

    public appendClaimEvent(input: AppendClaimEventInput): JobAppendEventResult {
        const run = this.#findFencedRun(input);
        if (run === undefined) return { kind: "lost-claim" };
        const eventBytes =
            utf8ByteLength(input.message ?? "") +
            utf8ByteLength(input.progressJson ?? "");
        const exhausted =
            run.payloadEventCount >= jobRunPayloadEventMaximum ||
            run.eventCount >= jobRunEventMaximum - 1 ||
            run.eventBytes + eventBytes > jobRunPayloadEventMaximumBytes;
        if (exhausted) {
            const alreadyTruncated =
                this.#transaction
                    .select({ sequence: jobRunEvents.sequence })
                    .from(jobRunEvents)
                    .where(
                        and(
                            eq(jobRunEvents.jobRunId, run.id),
                            eq(jobRunEvents.kind, "output-truncated")
                        )
                    )
                    .limit(1)
                    .get() !== undefined;
            if (alreadyTruncated || run.eventCount >= jobRunEventMaximum - 1) {
                return { kind: "dropped" };
            }
            const at = this.#touchRunForEvent(run, input.at);
            const event = this.#appendEvent(run.id, {
                attempt: run.attemptCount,
                kind: "output-truncated",
                occurredAt: at,
                workerInstanceId: input.workerId,
            });
            const refreshed = requiredRow(
                this.findRun(run.id),
                "truncated event run refresh"
            );
            this.#insertSideEffects(input.sideEffectsForRun(refreshed));
            return { event, kind: "truncated" };
        }
        const at = this.#touchRunForEvent(run, input.at);
        const event = this.#appendEvent(run.id, {
            attempt: run.attemptCount,
            kind: input.kind,
            message: input.message ?? null,
            occurredAt: at,
            progressJson: input.progressJson ?? null,
            workerInstanceId: input.workerId,
        });
        const refreshed = requiredRow(this.findRun(run.id), "appended event run refresh");
        this.#insertSideEffects(input.sideEffectsForRun(refreshed));
        return { event, kind: "appended" };
    }

    public settleClaim(input: SettleClaimInput): JobSettlementResult {
        const run = this.#findFencedRun(input);
        if (run === undefined) return { kind: "lost-claim" };
        const at = maximumDate(run.updatedAt, input.at);
        const outcome = effectiveSettlementOutcome(run, input.outcome);
        const canRetry =
            outcome.kind === "failed" &&
            outcome.retryAt !== undefined &&
            run.retrySafe &&
            run.attemptCount < run.attemptLimit;
        if (canRetry) {
            const retryAt = maximumDate(
                at,
                requiredRow(outcome.retryAt, "retry timestamp")
            );
            this.#touchRunForEvent(run, at);
            this.#appendEvent(run.id, {
                attempt: run.attemptCount,
                kind: "failed",
                message: boundedStructuralMessage(outcome.terminalMessage),
                occurredAt: at,
                workerInstanceId: input.workerId,
            });
            this.#releaseResources(run, input.workerId, input.leaseToken);
            const row = this.#transaction
                .update(jobRuns)
                .set({
                    availableAt: retryAt,
                    heartbeatAt: null,
                    leaseExpiresAt: null,
                    leaseOwnerId: null,
                    leaseToken: null,
                    state: "queued",
                    stateVersion: run.stateVersion + 1,
                    updatedAt: at,
                })
                .where(this.#claimFence(input))
                .returning()
                .get();
            requiredRow(row, "retry transition");
            this.#appendEvent(run.id, {
                attempt: run.attemptCount,
                kind: "retry-scheduled",
                occurredAt: at,
                workerInstanceId: input.workerId,
            });
            const refreshed = requiredRow(this.findRun(run.id), "retry refresh");
            this.#insertSideEffects(input.sideEffectsForRun(refreshed));
            return {
                kind: "retry-scheduled",
                run: refreshed,
            };
        }

        this.#releaseResources(run, input.workerId, input.leaseToken);
        const state = terminalStateForOutcome(outcome);
        const row = this.#transaction
            .update(jobRuns)
            .set({
                finishedAt: at,
                heartbeatAt: null,
                leaseExpiresAt: null,
                leaseOwnerId: null,
                leaseToken: null,
                resultJson: outcome.kind === "succeeded" ? outcome.resultJson : null,
                state,
                stateVersion: run.stateVersion + 1,
                terminalCode: outcome.kind === "succeeded" ? null : outcome.terminalCode,
                terminalMessage:
                    outcome.kind === "succeeded" ? null : outcome.terminalMessage,
                updatedAt: at,
            })
            .where(this.#claimFence(input))
            .returning()
            .get();
        if (row === undefined) return { kind: "lost-claim" };
        this.#appendEvent(run.id, {
            attempt: run.attemptCount,
            kind: state,
            ...(outcome.kind === "succeeded"
                ? {}
                : {
                      message: boundedStructuralMessage(outcome.terminalMessage),
                  }),
            occurredAt: at,
            workerInstanceId: input.workerId,
        });
        const refreshed = requiredRow(this.findRun(run.id), "settled claim refresh");
        this.#insertSideEffects(input.sideEffectsForRun(refreshed));
        return {
            kind: "settled",
            run: refreshed,
        };
    }

    #appendEvent(runId: string, input: InternalRunEventInput): JobRunEventRecord {
        const run = requiredRow(this.findRun(runId), "event parent read");
        const row = this.#transaction
            .insert(jobRunEvents)
            .values(
                v.parse(jobRunEventInsertSchema, {
                    ...input,
                    jobRunId: runId,
                    message: input.message ?? null,
                    progressJson: input.progressJson ?? null,
                    sequence: run.eventCount + 1,
                })
            )
            .returning()
            .get();
        return parseEvent(requiredRow(row, "run event insert"));
    }

    #cancelQueuedRun(
        run: JobRunRecord,
        actor: JobActor,
        input: ScheduleQueuedCancellation
    ): JobRunRecord {
        const at = maximumDate(run.updatedAt, input.at);
        const row = this.#transaction
            .update(jobRuns)
            .set({
                cancelRequestedAt: at,
                cancelRequestedById: actor.id,
                cancelRequestedByKind: actor.kind,
                finishedAt: at,
                state: "cancelled",
                stateVersion: run.stateVersion + 1,
                terminalCode: input.terminalCode,
                terminalMessage: input.terminalMessage,
                updatedAt: at,
            })
            .where(
                and(
                    eq(jobRuns.id, run.id),
                    eq(jobRuns.state, "queued"),
                    eq(jobRuns.stateVersion, run.stateVersion)
                )
            )
            .returning()
            .get();
        requiredRow(row, "queued run cancellation");
        this.#appendEvent(run.id, {
            attempt: run.attemptCount,
            kind: "cancel-requested",
            occurredAt: at,
            workerInstanceId: null,
        });
        this.#appendEvent(run.id, {
            attempt: run.attemptCount,
            kind: "cancelled",
            message: boundedStructuralMessage(input.terminalMessage),
            occurredAt: at,
            workerInstanceId: null,
        });
        return requiredRow(this.findRun(run.id), "cancelled run refresh");
    }

    #claimFence(input: ClaimFenceInput): SQL {
        return and(
            eq(jobRuns.id, input.runId),
            eq(jobRuns.state, "running"),
            eq(jobRuns.leaseOwnerId, input.workerId),
            eq(jobRuns.leaseToken, input.leaseToken),
            gt(jobRuns.leaseExpiresAt, input.at)
        ) as SQL;
    }

    #findFencedRun(input: ClaimFenceInput): JobRunRecord | undefined {
        const row = this.#transaction
            .select()
            .from(jobRuns)
            .where(this.#claimFence(input))
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    #findQueuedScheduleRun(scheduleId: string): JobRunRecord | undefined {
        const row = this.#transaction
            .select()
            .from(jobRuns)
            .where(
                and(
                    eq(jobRuns.scheduledJobId, scheduleId),
                    eq(jobRuns.triggerType, "schedule"),
                    eq(jobRuns.state, "queued")
                )
            )
            .get();
        return row === undefined ? undefined : parseRun(row);
    }

    #closeExpiredIntent(input: {
        readonly at: Date;
        readonly context: string;
        readonly intent: JobDisableIntentRecord;
        readonly systemActorId: string;
        readonly transitionAt: Date;
    }): JobDisableIntentRecord {
        const row = this.#transaction
            .update(jobDisableIntents)
            .set(
                v.parse(jobDisableIntentCloseSchema, {
                    endedAt: input.transitionAt,
                    endedById: input.systemActorId,
                    endedByKind: "system",
                    endedReason: "expired",
                })
            )
            .where(
                and(
                    eq(jobDisableIntents.id, input.intent.id),
                    isNull(jobDisableIntents.endedAt),
                    lte(jobDisableIntents.expiresAt, input.at)
                )
            )
            .returning()
            .get();
        return parseDisableIntent(requiredRow(row, input.context));
    }

    #findScheduleRecord(id: string): ScheduledJobRecord | undefined {
        const row = this.#transaction
            .select()
            .from(scheduledJobs)
            .where(eq(scheduledJobs.id, id))
            .get();
        return row === undefined ? undefined : parseSchedule(row);
    }

    #findWorker(id: string): WorkerInstanceRecord | undefined {
        const row = this.#transaction
            .select()
            .from(workerInstances)
            .where(eq(workerInstances.id, id))
            .get();
        return row === undefined ? undefined : parseWorker(row);
    }

    #insertSideEffects(input: JobMutationSideEffects): void {
        for (const event of input.auditEvents) {
            this.#transaction
                .insert(auditEvents)
                .values(v.parse(auditEventInsertSchema, event))
                .run();
        }
        for (const event of input.realtimeEvents) {
            this.#transaction
                .insert(realtimeEvents)
                .values(v.parse(realtimeEventInsertSchema, event))
                .run();
        }
    }

    #insertSuppliedEvent(input: JobRunEventInsert): JobRunEventRecord {
        const row = this.#transaction
            .insert(jobRunEvents)
            .values(v.parse(jobRunEventInsertSchema, input))
            .returning()
            .get();
        return parseEvent(requiredRow(row, "supplied run event insert"));
    }

    #releaseResources(run: JobRunRecord, workerId: string, leaseToken: string): void {
        const expectedKeys = resourceKeys(run);
        const released = this.#transaction
            .delete(resourceLeases)
            .where(
                and(
                    eq(resourceLeases.jobRunId, run.id),
                    eq(resourceLeases.workerInstanceId, workerId),
                    eq(resourceLeases.leaseToken, leaseToken)
                )
            )
            .returning({ resourceKey: resourceLeases.resourceKey })
            .all();
        if (
            released.length !== expectedKeys.length ||
            released.some(({ resourceKey }) => !expectedKeys.includes(resourceKey))
        ) {
            throw new Error("Claim resource lease set is incomplete during release");
        }
    }

    #scheduleColumns(schedule: ScheduleConfiguration) {
        if (schedule.kind === "interval") {
            return {
                cronExpression: null,
                intervalMs: schedule.intervalMs,
                scheduleKind: "interval" as const,
                timeOfDay: null,
                timeZone: null,
            };
        }
        if (schedule.kind === "daily") {
            return {
                cronExpression: null,
                intervalMs: null,
                scheduleKind: "daily" as const,
                timeOfDay: schedule.timeOfDay,
                timeZone: schedule.timeZone,
            };
        }
        return {
            cronExpression: schedule.expression,
            intervalMs: null,
            scheduleKind: "cron" as const,
            timeOfDay: null,
            timeZone: schedule.timeZone,
        };
    }

    #touchRunForEvent(run: JobRunRecord, requestedAt: Date): Date {
        const at = maximumDate(run.updatedAt, requestedAt);
        if (getTime(at) === getTime(run.updatedAt)) return at;
        const row = this.#transaction
            .update(jobRuns)
            .set({ updatedAt: at })
            .where(
                and(
                    eq(jobRuns.id, run.id),
                    eq(jobRuns.state, "running"),
                    eq(jobRuns.stateVersion, run.stateVersion)
                )
            )
            .returning({ id: jobRuns.id })
            .get();
        requiredRow(row, "run event timestamp update");
        return at;
    }

    #transitionClaim(
        run: JobRunRecord,
        changes: Partial<typeof jobRuns.$inferInsert>
    ): JobRunRecord {
        const leaseOwnerId = requiredValue(run.leaseOwnerId, "claim owner");
        const leaseToken = requiredValue(run.leaseToken, "claim token");
        const row = this.#transaction
            .update(jobRuns)
            .set(changes)
            .where(
                and(
                    eq(jobRuns.id, run.id),
                    eq(jobRuns.state, "running"),
                    eq(jobRuns.stateVersion, run.stateVersion),
                    eq(jobRuns.leaseOwnerId, leaseOwnerId),
                    eq(jobRuns.leaseToken, leaseToken)
                )
            )
            .returning()
            .get();
        return parseRun(requiredRow(row, "claim transition"));
    }
}

/**
 * Creates the SQLite-backed durable jobs repository.
 * @param database Process-owned synchronous Drizzle SQLite database.
 * @param writeAdmission Process-owned bounded immediate-write admission.
 * @returns Validated reads plus admitted atomic schedule/queue/worker transitions.
 */
export function createJobRepository(
    database: SQLiteBunDatabase,
    writeAdmission: ImmediateDatabaseWriteAdmission
): JobRepository & JobHealthStateReader & WorkerActionAvailabilityReader {
    // Drizzle exposes the synchronous transaction overload through a conditional
    // return type that cannot preserve our generic callback without this narrowing.
    const runTransaction = database.transaction.bind(database) as unknown as <T>(
        callback: (transaction: JobTransaction) => T,
        config: { behavior: "deferred" | "immediate" }
    ) => T;
    const read = <T>(callback: (reader: DrizzleJobReader) => T): T =>
        runTransaction((transaction) => callback(new DrizzleJobReader(transaction)), {
            behavior: "deferred",
        });
    const write = <T>(callback: (writer: DrizzleJobWriter) => T): Promise<T> =>
        writeAdmission.run((markTransactionStarted) =>
            runTransaction(
                (transaction) => {
                    markTransactionStarted();
                    return callback(new DrizzleJobWriter(transaction));
                },
                { behavior: "immediate" }
            )
        );

    return Object.freeze({
        appendClaimEvent: (input: AppendClaimEventInput) =>
            write((writer) => writer.appendClaimEvent(input)),
        beginWorkerDrain: (input: WorkerLifecycleMutationInput) =>
            write((writer) => writer.beginWorkerDrain(input)),
        cancelRun: (input: CancelRunRepositoryInput) =>
            write((writer) => writer.cancelRun(input)),
        claimNextRun: (input: ClaimNextRunInput) =>
            write((writer) => writer.claimNextRun(input)),
        enqueueManualRun: (input: EnqueueManualRunInput) =>
            write((writer) => writer.enqueueManualRun(input)),
        enqueueNextDueSchedule: (input: DueScheduleEnqueueInput) =>
            write((writer) => writer.enqueueNextDueSchedule(input)),
        expireDisableIntents: (input: ExpireDisableIntentsInput) =>
            write((writer) => writer.expireDisableIntents(input)),
        findActiveDisableIntent: (scheduleId: string) =>
            read((reader) => reader.findActiveDisableIntent(scheduleId)),
        findActiveRunForSchedule: (scheduleId: string) =>
            read((reader) => reader.findActiveRunForSchedule(scheduleId)),
        findLatestRunForSchedule: (scheduleId: string) =>
            read((reader) => reader.findLatestRunForSchedule(scheduleId)),
        findRun: (id: string) => read((reader) => reader.findRun(id)),
        findRunByIdempotency: (
            requestedByKind: JobRunRecord["requestedByKind"],
            requestedById: string,
            idempotencyKey: string
        ) =>
            read((reader) =>
                reader.findRunByIdempotency(
                    requestedByKind,
                    requestedById,
                    idempotencyKey
                )
            ),
        findRunDetail: (input: ListJobRunEventsInput) =>
            read((reader) => reader.findRunDetail(input)),
        findSchedule: (id: string) => read((reader) => reader.findSchedule(id)),
        heartbeatWorker: (input: WorkerLifecycleInput) =>
            write((writer) => writer.heartbeatWorker(input)),
        listDueSchedules: (input: ListDueSchedulesInput) =>
            read((reader) => reader.listDueSchedules(input)),
        listActiveActionPayloads: (input: ListActiveActionPayloadsInput) =>
            read((reader) => reader.listActiveActionPayloads(input)),
        listRunEvents: (input: ListJobRunEventsInput) =>
            read((reader) => reader.listRunEvents(input)),
        listRuns: (input: ListJobRunsInput) => read((reader) => reader.listRuns(input)),
        listRunsWithQueueState: (input: ListJobRunsWithQueueStateInput) =>
            read((reader) => reader.listRunsWithQueueState(input)),
        listScheduleRuns: (input: ListScheduleRunsInput) =>
            read((reader) => reader.listScheduleRuns(input)),
        listSchedules: (input: ListSchedulesInput) =>
            read((reader) => reader.listSchedules(input)),
        readClaimCancellation: (input: ClaimFenceInput) =>
            read((reader) => reader.readClaimCancellation(input)),
        readActionPayloadRunSnapshots: (input: ReadActionPayloadRunSnapshotsInput) =>
            read((reader) => reader.readActionPayloadRunSnapshots(input)),
        readHealthState: (input: ReadJobHealthStateInput) =>
            read((reader) => reader.readHealthState(input)),
        readQueueState: (input: ReadQueueStateInput) =>
            read((reader) => reader.readQueueState(input)),
        readWorkerControl: () => read((reader) => reader.readWorkerControl()),
        readWorkerActionAvailability: (input: ReadWorkerActionAvailabilityInput) =>
            read((reader) => reader.readWorkerActionAvailability(input)),
        reconcileSchedules: (input: ReconcileSchedulesInput) =>
            write((writer) => writer.reconcileSchedules(input)),
        recoverExpiredClaims: (input: RecoverExpiredClaimsInput) =>
            write((writer) => writer.recoverExpiredClaims(input)),
        registerWorker: (input: RegisterWorkerInput) =>
            write((writer) => writer.registerWorker(input)),
        renewClaim: (input: RenewClaimInput) =>
            write((writer) => writer.renewClaim(input)),
        setClaimingPaused: (input: SetClaimingPausedRepositoryInput) =>
            write((writer) => writer.setClaimingPaused(input)),
        settleClaim: (input: SettleClaimInput) =>
            write((writer) => writer.settleClaim(input)),
        stopWorker: (input: WorkerLifecycleMutationInput) =>
            write((writer) => writer.stopWorker(input)),
        updateSchedule: (input: UpdateScheduleRepositoryInput) =>
            write((writer) => writer.updateSchedule(input)),
    });
}
