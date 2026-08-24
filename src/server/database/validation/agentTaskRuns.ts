import { compareAsc } from "date-fns";
import {
    createInsertSchema,
    createSelectSchema,
    createUpdateSchema,
} from "drizzle-orm/valibot";
import * as v from "valibot";

import {
    agentCurrentTaskSchema,
    agentIdSchema,
    agentTaskRunIdSchema,
} from "../../../contracts/agentModel.ts";
import {
    automationPrincipalIdSchema,
    securityRecordIdSchema,
} from "../../../contracts/security.ts";
import { agentTaskRuns } from "../schema/agentTaskRuns.ts";
import { nonnegativeDateSchema } from "./scalars.ts";

const actorKindSchema = v.picklist(["automation", "user"]);

function actorIsValid(kind: "automation" | "user", id: string): boolean {
    return v.safeParse(
        kind === "automation" ? automationPrincipalIdSchema : securityRecordIdSchema,
        id
    ).success;
}

function runIsConsistent(run: {
    readonly completedAt: Date | null;
    readonly completedById: string | null;
    readonly completedByKind: "automation" | "user" | null;
    readonly lastActivityAt: Date;
    readonly lastUpdatedById: string;
    readonly lastUpdatedByKind: "automation" | "user";
    readonly startedAt: Date;
    readonly startedById: string;
    readonly startedByKind: "automation" | "user";
}): boolean {
    const completedActorIsConsistent =
        run.completedAt === null
            ? run.completedById === null && run.completedByKind === null
            : run.completedById !== null &&
              run.completedByKind !== null &&
              actorIsValid(run.completedByKind, run.completedById);
    return (
        completedActorIsConsistent &&
        actorIsValid(run.startedByKind, run.startedById) &&
        actorIsValid(run.lastUpdatedByKind, run.lastUpdatedById) &&
        compareAsc(run.lastActivityAt, run.startedAt) >= 0 &&
        (run.completedAt === null || compareAsc(run.completedAt, run.lastActivityAt) >= 0)
    );
}

const refinements = {
    agentId: () => agentIdSchema,
    completedAt: nonnegativeDateSchema,
    completedById: () => v.nullable(v.string()),
    completedByKind: () => v.nullable(actorKindSchema),
    id: () => agentTaskRunIdSchema,
    lastActivityAt: nonnegativeDateSchema,
    lastUpdatedById: () => v.string(),
    lastUpdatedByKind: () => actorKindSchema,
    startedAt: nonnegativeDateSchema,
    startedById: () => v.string(),
    startedByKind: () => actorKindSchema,
    task: () => agentCurrentTaskSchema,
};

const generatedSelectSchema = createSelectSchema(agentTaskRuns, refinements);
const selectObjectSchema = v.strictObject(generatedSelectSchema.entries);

/** Validates one agent task run read from SQLite. */
export const agentTaskRunSelectSchema = v.pipe(
    selectObjectSchema,
    v.check((run) => runIsConsistent(run), "Agent task run is inconsistent")
);

const generatedInsertSchema = createInsertSchema(agentTaskRuns, refinements);
const insertObjectSchema = v.strictObject(generatedInsertSchema.entries);

/** Validates one new active agent task run before insertion. */
export const agentTaskRunInsertSchema = v.pipe(
    insertObjectSchema,
    v.check((run) => runIsConsistent(run), "Agent task run is inconsistent")
);

const generatedUpdateSchema = createUpdateSchema(agentTaskRuns, refinements);

/** Validates the complete mutable projection used to touch or finish a run. */
export const agentTaskRunUpdateSchema = v.strictObject({
    completedAt: generatedUpdateSchema.entries.completedAt,
    completedById: generatedUpdateSchema.entries.completedById,
    completedByKind: generatedUpdateSchema.entries.completedByKind,
    lastActivityAt: generatedUpdateSchema.entries.lastActivityAt,
    lastUpdatedById: generatedUpdateSchema.entries.lastUpdatedById,
    lastUpdatedByKind: generatedUpdateSchema.entries.lastUpdatedByKind,
});
