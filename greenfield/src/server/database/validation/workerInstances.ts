import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    jobActionKeySchema,
    jobWorkerCapacityMaximum,
    jobWorkerStateSchema,
} from "../../../contracts/jobModel.ts";
import { utf8ByteLength } from "../../../shared/encoding.ts";
import { parseJsonText } from "../../../shared/json.ts";
import {
    compareStrings,
    fullCommitShaSchema,
    hasUniqueArrayItems,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import {
    workerActionKeyMaximum,
    workerActionKeysMaximumBytes,
} from "../schema/jobChecks.ts";
import { workerInstances } from "../schema/workerInstances.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";

function actionKeysAreCanonical(keys: string[]): boolean {
    return (
        hasUniqueArrayItems(keys) &&
        keys.every((key, index) => {
            const previous = keys[index - 1];
            return previous === undefined || compareStrings(previous, key) < 0;
        }) &&
        utf8ByteLength(JSON.stringify(keys)) <= workerActionKeysMaximumBytes
    );
}

/** Strict bounded canonical worker action inventory. */
export const workerActionKeysSchema = v.pipe(
    v.array(jobActionKeySchema, "Worker action keys are invalid"),
    v.maxLength(workerActionKeyMaximum, "Worker action keys are outside their budget"),
    v.check(actionKeysAreCanonical, "Worker action keys are not canonical")
);

/**
 * Canonicalizes one validated release-owned executable-action inventory.
 * @param actionKeys Candidate action identities from worker action definitions.
 * @returns Frozen sorted unique keys safe to persist as worker identity.
 */
export function canonicalWorkerActionKeys(
    actionKeys: readonly string[]
): readonly string[] {
    const sorted = actionKeys
        .map((actionKey) => v.parse(jobActionKeySchema, actionKey))
        .toSorted(compareStrings);
    return Object.freeze([...v.parse(workerActionKeysSchema, sorted)]);
}

/**
 * Serializes one canonical inventory without whitespace or unbounded fields.
 * @param actionKeys Candidate action identities.
 * @returns Canonical JSON text accepted by the worker persistence boundary.
 */
export function serializeWorkerActionKeys(actionKeys: readonly string[]): string {
    return JSON.stringify(canonicalWorkerActionKeys(actionKeys));
}

/**
 * Parses the immutable action inventory stored on one worker row.
 * @param value Stored JSON text.
 * @returns Frozen validated canonical action identities.
 */
export function parseWorkerActionKeysJson(value: string): readonly string[] {
    const parsed = v.parse(workerActionKeysSchema, parseJsonText(value));
    return Object.freeze([...parsed]);
}

const workerCapacitySchema = v.pipe(
    positiveSafeIntegerSchema("Stored worker capacity is invalid"),
    v.maxValue(jobWorkerCapacityMaximum, "Stored worker capacity is invalid")
);
const workerPidSchema = v.pipe(
    positiveSafeIntegerSchema("Stored worker pid is invalid"),
    v.maxValue(2_147_483_647, "Stored worker pid is invalid")
);
const workerActionKeysJsonSchema = v.pipe(
    v.string("Stored worker action keys are invalid"),
    v.check((value) => {
        try {
            parseWorkerActionKeysJson(value);
            return true;
        } catch {
            return false;
        }
    }, "Stored worker action keys are invalid")
);

interface StoredWorkerInstance {
    readonly drainingAt?: Date | null;
    readonly heartbeatAt: Date;
    readonly startedAt: Date;
    readonly state: "draining" | "online" | "stopped";
    readonly stoppedAt?: Date | null;
}

function workerLifecycleIsConsistent(worker: StoredWorkerInstance): boolean {
    const drainingAt = worker.drainingAt ?? null;
    const stoppedAt = worker.stoppedAt ?? null;
    if (worker.heartbeatAt.getTime() < worker.startedAt.getTime()) return false;
    if (
        (worker.state === "online" && (drainingAt !== null || stoppedAt !== null)) ||
        (worker.state === "draining" && (drainingAt === null || stoppedAt !== null)) ||
        (worker.state === "stopped" && (drainingAt === null || stoppedAt === null))
    ) {
        return false;
    }
    return (
        (drainingAt === null || drainingAt.getTime() >= worker.startedAt.getTime()) &&
        (stoppedAt === null ||
            stoppedAt.getTime() >= (drainingAt ?? worker.startedAt).getTime()) &&
        (stoppedAt === null || stoppedAt.getTime() >= worker.heartbeatAt.getTime())
    );
}

const workerRefinements = {
    actionKeysJson: () => workerActionKeysJsonSchema,
    capacity: () => workerCapacitySchema,
    drainingAt: nonnegativeDateSchema,
    heartbeatAt: nonnegativeDateSchema,
    id: uuidV7TextSchema,
    pid: () => workerPidSchema,
    releaseId: () => fullCommitShaSchema("Stored worker release id is invalid"),
    startedAt: nonnegativeDateSchema,
    state: () => jobWorkerStateSchema,
    stoppedAt: nonnegativeDateSchema,
};

const generatedWorkerInstanceSelectSchema = createSelectSchema(
    workerInstances,
    workerRefinements
);
const workerInstanceSelectObjectSchema = v.strictObject(
    generatedWorkerInstanceSelectSchema.entries
);

/** Validates one complete worker registration read from SQLite. */
export const workerInstanceSelectSchema = v.pipe(
    workerInstanceSelectObjectSchema,
    v.check(
        (worker) => workerLifecycleIsConsistent(worker),
        "Stored worker lifecycle is inconsistent"
    )
);

const generatedWorkerInstanceInsertSchema = createInsertSchema(
    workerInstances,
    workerRefinements
);
const workerInstanceInsertObjectSchema = v.strictObject({
    ...generatedWorkerInstanceInsertSchema.entries,
    actionKeysJson: workerActionKeysJsonSchema,
});

/** Validates one initially-online worker registration before insertion. */
export const workerInstanceInsertSchema = v.pipe(
    workerInstanceInsertObjectSchema,
    v.check(
        (worker) =>
            worker.state === "online" &&
            worker.drainingAt == null &&
            worker.stoppedAt == null &&
            workerLifecycleIsConsistent(worker),
        "New worker registration must be online and consistent"
    )
);
