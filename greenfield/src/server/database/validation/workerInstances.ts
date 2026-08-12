import { createInsertSchema, createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    jobWorkerCapacityMaximum,
    jobWorkerStateSchema,
} from "../../../contracts/jobModel.ts";
import {
    fullCommitShaSchema,
    positiveSafeIntegerSchema,
} from "../../../shared/validation.ts";
import { workerInstances } from "../schema/workerInstances.ts";
import { nonnegativeDateSchema, uuidV7TextSchema } from "./scalars.ts";
import { parseWorkerActionKeysJson } from "./workerActionKeys.ts";

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
