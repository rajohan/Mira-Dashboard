import { createSelectSchema } from "drizzle-orm/valibot";
import * as v from "valibot";

import { jobVersionSchema } from "../../../contracts/jobModel.ts";
import { jobWorkerControl } from "../schema/jobWorkerControl.ts";
import { jobActorIdentityIsValid } from "./jobActors.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const controlActorKindSchema = v.picklist(["automation", "user"]);

interface StoredWorkerControl {
    readonly claimingPaused: boolean;
    readonly id: number;
    readonly updatedAt: Date;
    readonly updatedById: string | null;
    readonly updatedByKind: "automation" | "user" | null;
    readonly version: number;
}

function workerControlIsConsistent(control: StoredWorkerControl): boolean {
    if (control.id !== 1) return false;
    const hasActor = control.updatedByKind !== null;
    if (hasActor !== (control.updatedById !== null)) return false;
    if (!hasActor) {
        return (
            control.version === 1 &&
            !control.claimingPaused &&
            control.updatedAt.getTime() === 0
        );
    }
    return (
        control.version > 1 &&
        control.updatedByKind !== null &&
        control.updatedById !== null &&
        jobActorIdentityIsValid(control.updatedByKind, control.updatedById)
    );
}

const controlRefinements = {
    updatedAt: nonnegativeDateSchema,
    updatedById: () => v.nullable(v.string()),
    updatedByKind: () => v.nullable(controlActorKindSchema),
    version: () => jobVersionSchema,
};
const generatedWorkerControlSelectSchema = createSelectSchema(
    jobWorkerControl,
    controlRefinements
);
const workerControlSelectObjectSchema = v.strictObject(
    generatedWorkerControlSelectSchema.entries
);

/** Validates the required singleton worker-control row read from SQLite. */
export const jobWorkerControlSelectSchema = v.pipe(
    workerControlSelectObjectSchema,
    v.check(workerControlIsConsistent, "Stored worker control is inconsistent")
);

const workerControlUpdateObjectSchema = v.strictObject({
    claimingPaused: v.boolean("Worker claiming state is invalid"),
    updatedAt: nonnegativeDateSchema(v.date("Worker control timestamp is invalid")),
    updatedById: v.string("Worker control actor id is invalid"),
    updatedByKind: controlActorKindSchema,
    version: jobVersionSchema,
});

/** Validates one complete versioned worker-control mutation. */
export const jobWorkerControlUpdateSchema = v.pipe(
    workerControlUpdateObjectSchema,
    v.check(
        (control) =>
            control.version > 1 &&
            jobActorIdentityIsValid(control.updatedByKind, control.updatedById),
        "Worker control update actor is invalid"
    )
);
